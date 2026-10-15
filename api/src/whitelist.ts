// Hält die Minecraft-Whitelist mit den Website-Konten synchron:
// Spieler und Admins mit eingetragenem Minecraft-Namen stehen drauf, alle anderen nicht.
// Es werden nur Namen entfernt, die die Website selbst hinzugefügt hat – manuelle Einträge bleiben.
import { Rcon } from './rcon.ts';
import { audit, getUser, setWhitelistState, type Role } from './users.ts';

/** Welcher Name sollte für diesen Benutzer auf der Whitelist stehen? */
export function desiredWhitelistName(role: Role, minecraftName: string | null): string | null {
  return role === 'player' || role === 'admin' ? minecraftName : null;
}

/** Nötige Befehle, um vom aktuellen zum gewünschten Zustand zu kommen. */
export function whitelistCommands(current: string | null, desired: string | null): string[] {
  const commands: string[] = [];
  const same = current !== null && desired !== null && current.toLowerCase() === desired.toLowerCase();
  if (current && !same) commands.push(`whitelist remove ${current}`);
  if (desired && !same) commands.push(`whitelist add ${desired}`);
  return commands;
}

/** Wertet die Antwort von "whitelist add" aus; undefined = ok, sonst Fehlermeldung. */
export function addError(answer: string): string | undefined {
  if (/added|already whitelisted/i.test(answer)) return undefined;
  if (/does not exist|unknown|not found/i.test(answer)) return 'Minecraft-Name existiert nicht.';
  return `Unerwartete Antwort: ${answer}`;
}

export async function syncWhitelist(userId: number, actorId: number | null): Promise<void> {
  const user = getUser(userId);
  if (!user) return;
  const desired = desiredWhitelistName(user.role, user.minecraftName);
  const commands = whitelistCommands(user.whitelistedName, desired);
  if (!commands.length) return;

  const rcon = new Rcon();
  try {
    await rcon.connect();
    let whitelisted = user.whitelistedName;
    let error: string | null = null;
    for (const cmd of commands) {
      const answer = await rcon.command(cmd);
      if (cmd.startsWith('whitelist remove')) {
        whitelisted = null;
        audit(actorId, 'whitelist entfernt', `${cmd.split(' ').pop()} (${user.displayName})`);
      } else {
        error = addError(answer) ?? null;
        if (!error) {
          whitelisted = desired;
          audit(actorId, 'whitelist hinzugefügt', `${desired} (${user.displayName})`);
        }
      }
    }
    setWhitelistState(userId, whitelisted, error);
  } catch (err) {
    setWhitelistState(userId, user.whitelistedName, `Server nicht erreichbar: ${(err as Error).message}`);
  } finally {
    rcon.close();
  }
}
