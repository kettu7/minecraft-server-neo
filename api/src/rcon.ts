// Minimaler RCON-Client (Source-RCON-Protokoll, wie es Minecraft spricht).
import { Socket, connect } from 'node:net';

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;

/** Minecraft teilt lange Antworten in Stücke zu 4096 Zeichen (gleiche Paket-ID). */
const FRAGMENT_SIZE = 4096;
/** Kommt nach einem vollen Stück nichts mehr, war es das letzte (Antwort genau 4096 Zeichen lang). */
const FRAGMENT_WAIT_MS = 250;
/** Verbindungsaufbau: Server aus oder im Neustart → schnell aufgeben statt ewig zu warten */
const CONNECT_TIMEOUT_MS = 10_000;
/** Standard-Zeitgrenze pro Befehl. Startet der Server mittendrin neu, kommt nie eine Antwort –
 *  ohne Grenze hinge der Aufrufer (z. B. ein Backup) für immer. */
export const COMMAND_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  parts: string[];
  timer?: NodeJS.Timeout;
}

export class Rcon {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();

  private readonly host = process.env.RCON_HOST ?? '127.0.0.1';
  private readonly port = Number(process.env.RCON_PORT ?? 25575);
  private readonly password = process.env.RCON_PASSWORD ?? '';

  async connect(): Promise<void> {
    if (!this.password) throw new Error('RCON_PASSWORD ist nicht gesetzt (siehe .env).');
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host: this.host, port: this.port }, () => {
        clearTimeout(timer);
        resolve(s);
      });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('Minecraft-Server nicht erreichbar (Zeitüberschreitung).'));
      }, CONNECT_TIMEOUT_MS);
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    // Verschwindet der Container, kommt evtl. kein Verbindungsende an → TCP-Keepalive bemerkt es
    this.socket.setKeepAlive(true, 10_000);
    this.socket.on('data', (chunk) => this.onData(chunk as Buffer));
    this.socket.on('error', (err) => this.failAll(err));
    this.socket.on('close', () => this.failAll(new Error('RCON-Verbindung geschlossen')));
    await this.send(TYPE_AUTH, this.password).catch(() => {
      throw new Error('RCON-Anmeldung fehlgeschlagen (Passwort falsch?).');
    });
  }

  /**
   * Befehle laufen strikt nacheinander: Minecraft verarbeitet pro Lesevorgang nur ein Paket
   * und trennt die Verbindung, wenn mehrere auf einmal ankommen.
   */
  command(cmd: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
    const result = this.queue.then(() => this.send(TYPE_COMMAND, cmd, timeoutMs));
    this.queue = result.catch(() => undefined);
    return result;
  }

  close() {
    this.socket?.end();
    this.socket = undefined;
  }

  private send(type: number, body: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
    const id = this.nextId++;
    const payload = Buffer.from(body, 'utf8');
    const packet = Buffer.alloc(14 + payload.length);
    packet.writeInt32LE(10 + payload.length, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    payload.copy(packet, 12);
    return new Promise((resolve, reject) => {
      // Keine Antwort in der Zeit: Verbindung ist nicht mehr brauchbar → alles Offene abbrechen
      const deadline = setTimeout(() => {
        this.failAll(new Error(`Keine Antwort vom Minecraft-Server auf „${body.split(' ')[0]}“ (Zeitüberschreitung).`));
        this.socket?.destroy();
      }, timeoutMs);
      const done = <T>(fn: (v: T) => void) => (v: T) => {
        clearTimeout(deadline);
        fn(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), parts: [] });
      if (!this.socket || this.socket.destroyed) return this.failAll(new Error('RCON-Verbindung geschlossen'));
      this.socket.write(packet);
    });
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (this.buffer.length < 4 + length) return;
      const id = this.buffer.readInt32LE(4);
      const body = this.buffer.toString('utf8', 12, 4 + length - 2);
      this.buffer = this.buffer.subarray(4 + length);

      if (id === -1) {
        // Antwort auf fehlgeschlagene Anmeldung
        const [first] = this.pending.values();
        this.pending.clear();
        first?.reject(new Error('auth'));
        continue;
      }
      const p = this.pending.get(id);
      if (!p) continue;
      clearTimeout(p.timer);
      p.parts.push(body);
      if (body.length < FRAGMENT_SIZE) this.finish(id);
      else p.timer = setTimeout(() => this.finish(id), FRAGMENT_WAIT_MS);
    }
  }

  private finish(id: number) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(p.parts.join(''));
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
