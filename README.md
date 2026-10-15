# Minecraft Server Neo

Fabric-Survival (Version 26.3), nah an Vanilla, mit Performance- und QoL-Mods.
Läuft lokal in Docker und lässt sich später 1:1 auf einen VPS umziehen.

## Voraussetzungen
- Docker Desktop (WSL 2 Backend) läuft
- In `docker-compose.yml` `EULA` auf `"TRUE"` gesetzt (nach Lesen der Mojang-EULA)

## Schnellstart
Alles läuft in Docker (Server, Karte, API, Website) und startet automatisch mit Docker Desktop.
**Doppelklick auf `start.cmd`** baut bei Bedarf neu, startet alles und öffnet die Website.

| Container | Aufgabe | Erreichbar |
|---|---|---|
| `mc-neo` | Minecraft + BlueMap | `localhost:25565`; Karte in der Website unter **Karte** (`/map/`, nur angemeldet) |
| `neo-api` | Projekte, Lager, Konten, Backups, Automatik | nur intern (über `/api`) |
| `neo-web` | Website (nginx) | **http://localhost:4200** |
| `neo-control` | Steuerdienst: Server starten/stoppen, Welt zurückspielen (einziger mit Docker-Zugriff) | nur intern, mit Token |

Nach Code-Änderungen: `docker compose up -d --build` (macht `start.cmd` automatisch).
Daten bleiben dabei erhalten: `api/data/` (Website), `backups/`, Volume `mc-data` (Welt).

**Entwickeln mit Live-Reload:** `docker compose stop api web`, dann wie unten mit `npm.cmd run dev` / `npm.cmd start`.
Nie beide gleichzeitig laufen lassen (doppelte Backups/Aktualisierung).

> In PowerShell `npm.cmd` statt `npm` verwenden, falls „Ausführung von Skripts ist deaktiviert“ erscheint.

## Anmeldung (nur Discord) & Rollen
Login ausschließlich über Discord (OAuth2, Scope `identify` – keine E-Mail, kein Passwort). Rollen werden auf der
Website vergeben: **Wartend** (neu, kein Zugriff) → **Spieler** → **Admin**. Wer sich als Erster anmeldet, wird Admin.

Einrichtung im [Discord Developer Portal](https://discord.com/developers/applications) → App „Neo“ → OAuth2:
1. **Redirects:** `http://localhost:4200/api/auth/discord/callback` eintragen und speichern.
2. **Client Secret:** „Reset Secret“, Wert in `.env` bei `DISCORD_CLIENT_SECRET=` eintragen (nie teilen/committen).
3. Optional nur Mitglieder eines Discord-Servers zulassen: Server-ID in `DISCORD_GUILD_ID=`
   (Discord → Einstellungen → Erweitert → Entwicklermodus, dann Rechtsklick auf den Server → „Server-ID kopieren“).
4. API neu starten (`.env` wird nur beim Start gelesen).

Whitelist: Spieler/Admins mit Minecraft-Namen im Profil werden automatisch per RCON auf die Whitelist gesetzt und bei
Entzug der Rolle wieder entfernt (nur Einträge, die die Website selbst gesetzt hat). Aktiv wird die Whitelist erst mit
`ENABLE_WHITELIST: "TRUE"` in `docker-compose.yml`. Admin-Seite `/admin`: Rollen, Konten löschen, Protokoll.

## Bedienung
> „docker wurde nicht erkannt“? Terminal schließen und neu öffnen (PATH wird erst danach übernommen).

| Aktion | Befehl |
|---|---|
| Starten | `docker compose up -d` |
| Logs ansehen | `docker compose logs -f mc` |
| Konsole/Befehle | `docker exec -i mc-neo rcon-cli` (z. B. `whitelist add Name`) |
| Stoppen | `docker compose down` |
| Mods verwalten | Website → Admin → Mods: hinzufügen, deaktivieren, aktualisieren, dann „Übernehmen“ |
| Server-Image aktualisieren | `docker compose pull` und neu starten |

Verbinden im Spiel: **Multiplayer → Server hinzufügen → `localhost`**
Karte: http://localhost:8100

## Wichtig: Fabric-Client
Der Server läuft mit Fabric, Spieler können aber auch mit **normalem Vanilla-Minecraft 26.3** joinen.
Client-Mods (Jade, AppleSkin, Litematica …) sind optional.

## Karte (BlueMap)
In der Website unter **Karte** eingebettet (nginx leitet `/map/` an BlueMap weiter, nur für angemeldete Mitglieder,
weil die Karte Spielerpositionen zeigt). Die Website blendet eigene Marker ein: Bauprojekte (
Werkbank) und Lager (Truhe) als Symbole mit Namensschild; Klick öffnet die Detailseite, Hinweis beim Drüberfahren zeigt den Fortschritt. Projekt- und
Lagerseiten haben „Auf Karte zeigen“.

### BlueMap-Einrichtung
Beim ersten Start legt BlueMap `config/bluemap/core.conf` an und wartet auf `accept-download: true`
(lädt dafür die Minecraft-Client-Ressourcen von Mojang). Danach Server neu starten.

## Daten & Backups
Welt und Configs liegen im Docker-Volume `mc-data`, Website-Daten in `api/data/`.

**Automatische Backups** (laufen im Container `neo-api`) landen in `backups/<Datum_Uhrzeit>/`:
- `world.tar.gz` – Welt, `server.properties`, Whitelist, OPs, Bans, Mod-Configs (ohne BlueMap-Kacheln/Mods)
- `website.db` + `schematics/` + `images/` – Projekte, Lager, Konten, Projektbilder
- Ablauf: `save-off` → `save-all flush` → packen → `save-on` (Spiel läuft weiter)
- Aufbewahrung: alles der letzten 24 h, danach das neueste pro Tag für 14 Tage; angepinnte bleiben immer.
  Einstellbar in `.env`: `BACKUP_INTERVAL_MINUTES`, `BACKUP_KEEP_HOURS`, `BACKUP_KEEP_DAYS`.
- Verwaltung: Website → Admin → Backups (jetzt sichern, anpinnen, herunterladen, löschen).

**Zurückspielen:** Admin → Backups → „Zurückspielen“. Setzt nur die Welt zurück (Whitelist, OPs, Bans und
Website-Daten bleiben aktuell). Vorher wird automatisch ein angepinntes Sicherheits-Backup erstellt, Spieler
werden 10 Sekunden vorher gewarnt. Ausgeführt vom Steuerdienst `neo-control`.

## Website: Bauprojekte & Materialliste (Entwicklung)
`api/` (Node 24 + TypeScript, SQLite) und `web/` (Angular 22). Zwei Terminals:

| Terminal | Befehl | Adresse |
|---|---|---|
| API | `cd api; npm.cmd run dev` | http://localhost:3000 |
| Website | `cd web; npm.cmd start` | **http://localhost:4200** |

- Projektdaten liegen in `api/data/` (Datenbank, hochgeladene Schematics, Projektbilder in `images/`).
- **Blaupause herunterladen:** Knopf auf der Projektseite liefert die Original-`.litematic` (in den `schematics`-Ordner
  der Minecraft-Instanz legen, dann im Spiel `M` → Load Schematics). Litematica selbst lädt nur lokal.
- **Projektbilder:** auf der Projektseite hochladen, per Strg+V einfügen oder hineinziehen. Der Browser verkleinert
  auf max. 1600 px (+ Vorschau 400 px, WebP); in der Liste erscheint das Vorschaubild links. Bilder sind Teil der Backups.
- **Baufortschritt:** Auf der Projektseite den Standort aus Litematica eintragen (`M` → Schematic Placements →
  Configure) und „Baufortschritt prüfen“ klicken. Die API fragt jeden Block per RCON ab
  (`execute if block …`, nur Block-ID, keine Ausrichtung). Nicht geladene Chunks werden dafür kurz per
  `/forceload` geladen und danach wieder freigegeben. Grenze: 20.000 Blöcke pro Schematic.
- **Lager:** Unter „Lager“ Bereiche anlegen (Mitte, Radius in X/Z, Höhe ±Y). Der Scan fragt jede Position per
  `data get block` ab (~1 ms/Position, max. 20.000) und liest Kisten, Fallen-Kisten, Fässer und Shulkerkisten aus,
  auch Shulker in Kisten. Pro Lager schaltbar: Shulker einrechnen ja/nein.
- **Projekt ↔ Lager:** Ein Projekt nutzt beliebig viele Lager, ein Lager versorgt beliebig viele Projekte (geteilter
  Bestand). Pro Material: noch zu verbauen = Bedarf − verbaut; Status gedeckt/fehlt im Vergleich zum Lagerbestand.
- **Automatik:** Alle `REFRESH_MINUTES` (Standard 5) werden alle Lager neu gescannt und der Baufortschritt geprüft.
  Manuell: „Jetzt aktualisieren“ (Projekt) bzw. „Jetzt scannen“ (Lager).
- **Item-Bibliothek (Bilder + Namen):** wird aus dem Minecraft-Client erzeugt, den BlueMap schon geladen hat.
  Einmalig bzw. nach Minecraft-Updates:
  ```
  docker cp mc-neo:/data/bluemap/minecraft-client-26.3.jar .cache/
  cd api; npm run items
  ```
  Ergebnis: `web/public/items/<id>.png` (64×64, Blöcke isometrisch gerendert) und `items.json` mit englischen und
  deutschen Namen (Sprachdatei `de_de.json` wird einmalig von Mojangs Download-Server geladen, Prüfsumme kontrolliert,
  in `.cache/lang/`). Auf der Website schaltet **DE | EN** neben Suche/Filter nur die Item-Namen um.
  Ohne Bibliothek läuft die Website weiter, nur ohne Bilder. Die Bilder sind Mojang-Assets und bleiben
  deshalb außerhalb von Git (`.gitignore`).
- **RCON-Passwort** steht in `.env` (nicht im Repo, Vorlage: `.env.example`). Docker und API lesen es beide.
  RCON-Test: `cd api; node --env-file=../.env test/rcon-probe.ts`
- Tests des Litematic-Parsers: `cd api; npm test`
- Beispieldatei ohne Spiel erzeugen: `cd api; node test/make-sample.ts` → `testdaten/beispiel-haus.litematic`

## Mods

Die Liste der Server-Mods verwaltet die Website (**Admin → Mods**) in `server/modrinth-projects.txt` –
mit fester Version je Mod. Der Server liest die Datei bei jedem Start und lädt die Mods von Modrinth.

- **Hinzufügen:** Suche bei Modrinth (nur Fabric-Mods für die laufende Version). Benötigte Mods kommen automatisch mit.
- **Deaktivieren:** Mod bleibt in der Liste (Version, Notiz), wird aber nicht geladen. Configs bleiben liegen.
- **Übernehmen:** Backup → Warnung im Chat → Neustart → Prüfung, ob alles installiert ist. Startet der Server nicht,
  wird die alte Liste zurückgeschrieben; das Server-Log steht auf der Seite.
- Eigene Jar-Dateien hochladen geht bewusst nicht (Sicherheit). Von Hand in `mods/` gelegte Dateien zeigt die Seite an.
- Fehlt `server/modrinth-projects.txt` (frische Installation), legt `start.cmd` sie aus der `.example`-Datei an.

## Modpack für Spieler

Website → **Modpack**: Download als `.mrpack` für die Modrinth App, mit Anleitung. Verwaltet wird es unter
**Admin → Modpack**:
- Server-Mods, die Spieler brauchen, sind automatisch Pflicht; reine Server-Mods bleiben draußen.
- Dazu kommen Spieler-Mods, Ressourcenpakete und Shader von Modrinth – je als Pflicht oder optional.
- Benötigte Mods kommen automatisch mit. Die Pack-Version zählt hoch, sobald sich der Inhalt ändert.
- Das Pack enthält nur Download-Links und Prüfsummen von Modrinth, keine Dateien.

## Offline-Demo zum Vorzeigen

Die ganze Website als **eine HTML-Datei**, die ohne Server und ohne Internet läuft (Doppelklick genügt).
Inhalt ist eine Momentaufnahme des aktuellen Stands; Änderungen sind darin nicht möglich, die Karte ist ein Standbild.

```
cd web
npx ng build
NEO_SESSION=<Sitzungs-Token eines Admins> npm run demo
```

Ergebnis: `web/demo/out/Neo-Demo.html` (ca. 12 MB). Kartenbild: `web/demo/map.png`.
Achtung: Die Datei enthält echte Namen, Ban-Liste und Protokoll – nicht einchecken, nur bewusst weitergeben.

## Roadmap
1. ✅ Grundsetup: Fabric-Server + Performance-Mods + BlueMap
2. ✅ Client: Litematica
3. ✅ Website: Bauprojekte & Materialliste aus `.litematic`-Dateien (MVP)
4. ✅ Baufortschritt per RCON (Standort eintragen → verbaute Blöcke prüfen)
5. ✅ Lager-Spiegelung: Bereiche scannen, Bestand pro Lager, Projekte ↔ Lager, Auto-Aktualisierung
6. ✅ Item-Bibliothek, UI im Minecraft-Glassmorphism-Stil
7. ✅ Discord-Login, Rollen (Wartend/Spieler/Admin + Inhaber), automatische Whitelist, Bans
8. ✅ Automatische Backups mit Verwaltung im Admin-Bereich
9. ✅ Alles in Docker (Server, API, Website)
10. ✅ Backup zurückspielen per Knopf, Admin → Server (Status, Whitelist an/aus, Kick/Ban, Ansagen, Neustart)
11. ✅ Admin → Mods: Mods suchen/hinzufügen/deaktivieren/aktualisieren, Übernehmen mit Backup + Neustart, Upgrade-Check
12. ✅ Modpack (.mrpack) für Spieler: Server-Mods + Spieler-Mods/Ressourcenpakete/Shader, Pflicht/optional, Download-Seite
13. ⏳ Config-Editor
14. ⏳ Zugang für Freunde (Tailscale/playit.gg/VPS)
15. ⏳ Server-Mod: große Bauten/Lager schneller prüfen, Live-Updates statt Polling
