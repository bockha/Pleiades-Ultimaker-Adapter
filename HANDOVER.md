# Handover: Ultimaker-3-Adapter „Dave“ und nächste Schritte zu einer Pleiades-Kachel

Stand: 2026-11-17, 22:35 MEZ. Repository: `Pleiades-Ultimaker-Adapter`, Branch `master`, nicht gepusht.

## 1. Was steht

Ein Adapter (TypeScript auf Node.js, MQTT 5) liest die lokale API des Ultimaker 3 „Dave“
(`http://192.168.100.27/api/v1`, Firmware 5.3.0) und publiziert nach dem
[MQTT-Binding des Playground](https://github.com/united-machining-solutions/Pleiades.Playground/blob/main/contracts/mqtt/README.md)
unter `machines/Dave/`. Details zu Topics, Einheiten und Alarmen stehen im [README](README.md).

| Wo | Status |
|---|---|
| Lokaler Container (`docker compose`) | **läuft**, publiziert als `Dave` auf `mqtt://vm01.hub0000.ums.internal:1883` (Benjamins Broker) |
| Gemeinsamer Stack (vm01) | speichert die Werte, geprüft über `http://vm01.hub0000.ums.internal:5500` (Timeseries API) |
| Dashboard | zeigt `Dave` als Maschine, Zustand aus `umati/State/*` |
| SFH-App 129, Version 0.1.0 (versionId 5156) | `testing`, auf SFH 1865 deployt (Deployment 10226, `reportedVersionId` 5156), **sendet aber nichts**, siehe 4. |

Commits: `3a92f44` (Adapter), `e7f179d` (SFH-Paket, gehärtetes Image), dazu dieses Handover.

## 2. Was Dave publiziert (die Grundlage für eine Kachel)

Alle Topics liegen unter `machines/Dave/`. Zahlen sind in SI-Einheiten, also Temperaturen in `degreeCelsius`,
Längen in `metre`, Zeiten in `second` und Anteile in `one` (1.0 = 100 %).

**Liest das Dashboard schon heute:** `umati/Connection/State`, `umati/Connection/Heartbeat`,
`umati/State/MachineryItemState`, `umati/State/MachineryOperationMode`, `umati/Production/ActiveProgram`.

**Neu und druckerspezifisch, von keiner Karte gezeigt** (der Kern einer Drucker-Kachel):

| Was | Topic | Art |
|---|---|---|
| Druckerstatus | `vendor/Printer/Status` | `idle`, `printing`, `error`, `maintenance`, `booting` |
| Job-Zustand | `vendor/PrintJob/State` | `none`, `pre_print`, `printing`, `paused`, `wait_cleanup`, … |
| Fortschritt | `vendor/PrintJob/Progress` | one (0..1) |
| Restzeit, Laufzeit, Gesamtzeit | `vendor/PrintJob/TimeRemaining`, `TimeElapsed`, `TimeTotal` | second |
| Jobname | `umati/Production/ActiveProgram` | string |
| Betttemperatur Ist / Soll | `vendor/Bed/Temperature`, `vendor/Bed/TargetTemperature` | degreeCelsius |
| Düse 1/2 Ist / Soll | `vendor/Head/1/Extruder/{1,2}/Hotend/Temperature`, `…/TargetTemperature` | degreeCelsius |
| Druckkern | `vendor/Head/1/Extruder/{1,2}/Hotend/Id` | z. B. `AA 0.4` |
| Material | `vendor/Head/1/Extruder/{1,2}/Material/Type`, `…/Color`, `…/ColorCode` | z. B. `PLA`, `Yellow`, `#f9a800` |
| Filament-Rest | `vendor/Head/1/Extruder/{1,2}/Material/LengthRemaining` | metre (fehlt, wenn unbekannt) |
| Lebensdauer Druckkern | `…/Hotend/MaterialExtruded` (metre), `…/Hotend/TimeSpentHot` (second) | |
| Alarme / Meldungen | `machines/Dave/events/notifications` | `printer-error` (Error), `printer-maintenance`, `job-wait-user-action` (Warning), `job-paused`, `job-wait-cleanup`, `log-*` (Information) |

Werte werden bei Änderung gesendet, unverändert spätestens nach 60 s. Temperaturen ändern sich praktisch bei jeder
Abfrage, also alle 5 s. Extruder 2 hat derzeit kein Material: `Material/Guid` ist leer, `Type`, `Color` und
`LengthRemaining` fehlen. Eine Kachel muss das abfangen.

## 3. Vorschlag: eine Drucker-Kachel in Pleiades

Die vorhandenen Karten helfen nicht direkt. `machine` zeigt nur Zustand, Programm und Alarme. `measurement` kennt
eine feste Liste von Größen einer Werkzeugmaschine (`apps/genui-mcp/src/measurements.ts`, `sources`), keine davon
liefert Dave. Für Dave braucht es also eine **neue Karte** nach dem Skill
`.claude/skills/create-card/SKILL.md` im Playground, gegebenenfalls danach eine Seite nach `create-page`.

### Skizze

- **Name:** `printer`, Tool `genui_printer_show` mit Parameter `machine` (z. B. `Dave`). Optional später
  `genui_printer_list` für alle Maschinen, die `vendor/Printer/Status` publizieren.
- **Antwort (Contract, zod)** in `packages/cards/src/printer/contract.ts`. Jeder Wert mit `value`, `at` und `topic`,
  wie bei `machine`:
  - `status`, `jobState`, `jobName`, `progress`, `timeRemaining`
  - `bed: { temperature, target }`
  - `extruders: [{ index, hotendId, temperature, target, material: { type, color, colorCode } | null, lengthRemaining | null }]`
  - `notifications` (offene Warning/Error) über die Events API, wie es `machine` schon tut
  - `live`: Heartbeat jünger als 30 s (`SILENT_AFTER_SECONDS`)
- **Kachel:** Kopfzeile mit Name, Zustand (Farbe wie bei `machine`) und Jobname. Darunter ein Fortschrittsbalken
  mit Restzeit. Dann Temperaturen als Ist/Soll-Paare (Bett, Düse 1, Düse 2) und je Druckkern ein Farbpunkt
  (`ColorCode`) mit Materialname und Restlänge. Unten offene Alarme.
- **Serie (optional, zweites Tool, das nur die Karte ruft):** Temperaturverlauf der letzten 30 min als Sparkline,
  so wie `machine` sein Band über ein eigenes Tool holt. Die Regel des Skills: Eine Serie geht nie an das
  Sprachmodell.
- **Regeln aus `create-card`:** Alles Rechnen (Restzeit, Formatierung von Dauer) geschieht im Tool, nicht in der
  Komponente. Jeder Wert nennt sein Topic. Was das Sprachmodell liest, bleibt kurz.

### Wo die Dateien hinkommen (laut Skill)

`packages/cards/src/printer/` (Contract, Komponente, Tests), `apps/genui-mcp/src/cards/printer.ts` plus eine
Zeile in `cards/index.ts`, die Rechenlogik in einer eigenen Datei unter `apps/genui-mcp/src/`,
`apps/app/src/cards/printer/chat.tsx` plus eine Zeile in `apps/app/src/chat/cards.tsx`,
`apps/genui-mcp/ui/printer.html`/`.tsx` für andere Hosts, sowie je eine Zeile in den README-Tabellen und in
`contracts/mcp/README.md`. Für den neuen Tool-Namen braucht der Pull Request ein Issue.

### Prüfen

```bash
pnpm typecheck && pnpm test && pnpm build
docker compose up -d --build --wait --no-deps genui-mcp app
node .claude/skills/build-your-own/look.mjs call genui_printer_show machine=Dave
node .claude/skills/build-your-own/show-card.mjs genui_printer_show machine=Dave   # im Hintergrund, im Browser öffnen
```

Eine Zahl der Antwort mit der Timeseries API vergleichen, z. B.
`GET /timeseries/baseUnitValues/topics/machines/Dave/vendor/Bed/Temperature?startTime=…&stopTime=…`.

### Testdaten für Zustände, die Dave gerade nicht hat

Dave ist meist `idle`. Druck, Pause, „Bauplatte räumen“ und Fehler liefert der Mock-Drucker in einer Schleife
(etwa 3 min):

```bash
node test/mock-printer.ts 8081
PRINTER_URL=http://localhost:8081 SERIAL_NUMBER=UM3-MOCK MQTT_URL=mqtt://localhost:1883 npm start
```

Das geht gegen einen **lokalen** Stack, nicht gegen Benjamins Broker, sonst steht `UM3-MOCK` im gemeinsamen
Dashboard. Im lokalen Stack auf diesem Rechner steht `UM3-MOCK` noch aus einem früheren Test. Er verschwindet
nach 24 h aus der Liste.

## 4. Offene Punkte

1. **SFH-Instanz sendet nicht.** Deployment 10226 meldet Version 5156 installiert, auf dem Broker kam in 4 min
   nichts an. Vermutung: Der DNS des SFH löst `vm01.hub0000.ums.internal` nicht auf, so wie zuvor im lokalen
   Container (gelöst dort mit `DNS_SERVER=192.168.100.1`). Prüfen: Pod-Log in der Management Console, gesucht
   ist `getaddrinfo ENOTFOUND`. Abhilfe ohne neue Version: neu deployen mit Value
   `mqttUrl=mqtt://192.168.20.137:1883`. Dafür braucht es ein frisches Token (das letzte ist abgelaufen).
2. **Zwei Instanzen vermeiden.** Sobald die SFH-Instanz sendet, den lokalen Container stoppen
   (`docker compose down`). Sonst laufen zwei Heartbeat-Zähler auf `machines/Dave/umati/Connection/Heartbeat`.
3. **Ursache des ersten Release-Fehlers.** Der erste `development-release` fiel ohne Meldung auf `development`
   zurück. Der Harbor-Scan des ersten Images zeigte 3 kritische und 48 hohe Schwachstellen. Erst mit dem
   gehärteten Image (ohne npm/yarn, `apk upgrade`) wurde die Version `testing`. Die Details des Scans ließen
   sich mit dem verfügbaren Harbor-Login nicht lesen, für das neue Image liegt kein Scan vor.
4. **Laufender Druck nie am echten Drucker gesehen.** Die Abbildung auf `Executing`/`Processing`, die Job-Werte
   und die Alarme sind nur mit dem Mock getestet. Beim ersten echten Druck prüfen.
5. **Issue für die `vendor/`-Topics.** Der Entwurf liegt in [`docs/issue-draft.md`](docs/issue-draft.md), noch
   nicht geöffnet. Für die Kachel kommt der neue Tool-Name (`contracts/mcp`) hinzu. Beides gehört in Issues,
   bevor der Code ins Playground-Repository geht.
6. **Adapter ins Playground übernehmen?** Er liegt in einem eigenen Repository. Laut `add-source` wäre der Platz
   `apps/ultimaker-adapter` mit pnpm-Workspace-Katalog und einem Compose-Eintrag (wohl unter einem Profil, weil
   er einen echten Drucker braucht). Das gehört zum Issue.

## 5. Nützliches

- Playground-Stack lokal: Klon im Scratchpad dieser Sitzung (wird beim Aufräumen gelöscht). Neu:
  `git clone https://github.com/united-machining-solutions/Pleiades.Playground`, dann
  `docker compose up -d --wait`. Die `:dev`-Images liegen auf diesem Rechner schon.
- Was der Stack gespeichert hat: `node .claude/skills/build-your-own/look.mjs` im Playground. Für Benjamins Stack
  `TIMESERIES_API_PORT` usw. gelten nur für `localhost`; dort direkt `http://vm01.hub0000.ums.internal:5500/`.
- Dashboard-Logik für Zustände: `packages/cards/src/machine/state.ts` (`stateFrom`). `NotExecuting` heißt dort
  „Stopped“, `Setup` heißt „Setup“, ein offener Error heißt „Alarm“.
- Material-Infos holt der Adapter aus `GET /api/v1/materials/{GUID}`. Firmware 5 liefert das XML als JSON-String.
