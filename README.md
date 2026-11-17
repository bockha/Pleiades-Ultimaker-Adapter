# Pleiades Ultimaker Adapter

Ein Adapter, der die Betriebsdaten eines **Ultimaker 3** über dessen lokale REST-API
(`http://<drucker>/api/v1`) liest und nach dem
[MQTT-Binding des Pleiades Playground](https://github.com/united-machining-solutions/Pleiades.Playground/blob/main/contracts/mqtt/README.md)
(Entwurf 0.2.0) auf den Broker publiziert. Der Drucker erscheint damit als Maschine
`machines/{SERIAL_NUMBER}` im Pleiades-Dashboard.

**Herkunft der Daten:** Es ist der eigene Drucker des Betreibers im LAN (Standard: `192.168.100.27`). Der Adapter
liest nur. Lesende Aufrufe der Ultimaker-API brauchen keine Anmeldung. Es gelten keine Nutzungsbedingungen Dritter.

## Start

```bash
cp .env.example .env          # PRINTER_URL, SERIAL_NUMBER und MQTT_URL anpassen
docker compose up -d --build --wait
curl http://localhost:5530/health
```

- Für den **lokalen Playground-Stack** bleibt `MQTT_URL=mqtt://host.docker.internal:1883`.
- Für den **gemeinsamen Broker am Hackathon** trägst du die Adresse von Benjamin in `.env` ein, zum Beispiel
  `MQTT_URL=mqtt://<host>:1883`.
- **Ohne Drucker:** `docker compose --profile mock up -d --build` startet zusätzlich einen simulierten
  Drucker. Setze dafür `PRINTER_URL=http://mock-printer:8081`.

Ohne Docker (Node.js ≥ 22.18): `npm ci && npm start`. Tests: `npm test`, Typprüfung: `npm run typecheck`.

## Einstellungen (Umgebung)

| Name | Standard | Bedeutung |
|---|---|---|
| `PRINTER_URL` | `http://192.168.100.27` | Basis-URL des Druckers |
| `SERIAL_NUMBER` | `UM3-01` (Compose) | Maschinen-ID im Topic, ohne `/`, `+`, `#` |
| `MQTT_URL` | `mqtt://host.docker.internal:1883` | Broker |
| `MQTT_USER`, `MQTT_PASSWORD` | leer | Anmeldung am Broker, falls nötig |
| `DNS_SERVER` | `8.8.8.8` | DNS des Containers. Für Broker mit LAN-Namen (z. B. `*.internal`) den DNS des LANs eintragen, siehe `resolvectl dns` |
| `POLL_INTERVAL_SECONDS` | `5` | Abfrageintervall des Druckers |
| `HEARTBEAT_INTERVAL_SECONDS` | `10` | Lebenszeichen, eigener Timer |
| `REPUBLISH_SECONDS` | `60` | Ein unveränderter Wert wird spätestens nach dieser Zeit erneut gesendet |

## Verhalten

- Der Adapter fragt alle 5 s `printer`, `printer/status`, `print_job` und `history/events` ab, alle 60 s
  `system`, und einmal je Material `materials/{GUID}`.
- Werte werden bei Änderung gesendet und unverändert spätestens nach `REPUBLISH_SECONDS`.
  `timestamp` ist der Zeitpunkt der Abfrage in UTC.
- Jeder Wert wird **einmal im Adapter** in die SI-Einheit des Binding umgerechnet: mm → `metre`,
  mm/s → `metrePerSecond`, Prozent → `one` (1.0 = 100 %), Grad → `radian`.
- Der Adapter nutzt **MQTT 5** und setzt den Content Type (`baseunitvaluedto`, `stringvaluedto`,
  `booleanvaluedto`, `notificationeventdtov1`).
- **Lebenszeichen:** Alle 10 s sendet ein eigener Timer `umati/Connection/State` und
  `umati/Connection/Heartbeat`. Solange der Drucker antwortet, ist der Zustand `Connected` und der Zähler steigt.
  Antwortet der Drucker nicht, ist der Zustand `Disconnected` und der Zähler steht. Nach 30 s gilt der
  Drucker dann als still.
- `/health` auf Port 8080 antwortet mit 200, solange die Verbindung zum Broker steht. Der Healthcheck des Images
  prüft das.

## Topics

Alle Topics liegen unter `machines/{SERIAL_NUMBER}/`.

### `umati/` – im Binding benannt

| Topic | Art | Quelle / Abbildung |
|---|---|---|
| `umati/Connection/State` | string | `Connected` / `Disconnected` |
| `umati/Connection/Heartbeat` | number, `one` | Zähler |
| `umati/State/MachineryItemState` | string | `printing` + aktiver Job → `Executing`; `idle`, pausiert → `NotExecuting`; `error`, `maintenance` → `OutOfService`; `booting` → `NotAvailable` |
| `umati/State/MachineryOperationMode` | string | aktiver oder pausierter Job → `Processing`; `wait_cleanup` → `Setup`; `maintenance` → `Maintenance`; sonst `None` |
| `umati/Channel/1/ChannelState` | string | Job aktiv → `Active`; pausiert oder wartet auf Bediener → `Interrupted`; sonst `Reset` |
| `umati/Production/ActiveProgram` | string | Name des Druckjobs, leer ohne Job |

### `vendor/` – Ultimaker-spezifisch (Vorschlag, siehe unten)

| Topic | Art | Einheit |
|---|---|---|
| `vendor/Printer/Status` | string | – (`idle`, `printing`, `error`, `maintenance`, `booting`) |
| `vendor/Bed/Temperature`, `vendor/Bed/TargetTemperature` | number | `degreeCelsius` |
| `vendor/Bed/PreHeatActive` | boolean | – |
| `vendor/Bed/Type` | string | – |
| `vendor/Head/1/Position/X`, `…/Y`, `…/Z` | number | `metre` |
| `vendor/Head/1/MaxSpeed/X`, `…/Y`, `…/Z` | number | `metrePerSecond` |
| `vendor/Head/1/Acceleration` | number | `metrePerSecondSquared` |
| `vendor/Head/1/Fan` | number | `one` |
| `vendor/Head/1/Extruder/{1,2}/Hotend/Temperature`, `…/TargetTemperature` | number | `degreeCelsius` |
| `vendor/Head/1/Extruder/{1,2}/Hotend/Id`, `…/Serial` | string | – (z. B. `AA 0.4`) |
| `vendor/Head/1/Extruder/{1,2}/Hotend/MaterialExtruded` | number | `metre` (Filamentlänge) |
| `vendor/Head/1/Extruder/{1,2}/Hotend/MaxTemperatureExposed` | number | `degreeCelsius` |
| `vendor/Head/1/Extruder/{1,2}/Hotend/TimeSpentHot` | number | `second` |
| `vendor/Head/1/Extruder/{1,2}/Hotend/Offset/State` | string | – (`valid`, `invalid`) |
| `vendor/Head/1/Extruder/{1,2}/Hotend/Offset/X`, `…/Y`, `…/Z` | number | `metre` |
| `vendor/Head/1/Extruder/{1,2}/Feeder/MaxSpeed` | number | `metrePerSecond` |
| `vendor/Head/1/Extruder/{1,2}/Feeder/Acceleration` | number | `metrePerSecondSquared` |
| `vendor/Head/1/Extruder/{1,2}/Material/Guid`, `…/Brand`, `…/Type`, `…/Color`, `…/ColorCode` | string | – |
| `vendor/Head/1/Extruder/{1,2}/Material/LengthRemaining` | number | `metre` (nur wenn bekannt) |
| `vendor/Network/Wifi/Connected`, `vendor/Network/Ethernet/Connected` | boolean | – (keine Netznamen) |
| `vendor/Led/Hue` | number | `radian` |
| `vendor/Led/Saturation`, `vendor/Led/Brightness` | number | `one` |
| `vendor/PrintJob/State` | string | – (`none`, `pre_print`, `printing`, `paused`, `wait_cleanup`, …) |
| `vendor/PrintJob/Progress` | number | `one` |
| `vendor/PrintJob/TimeElapsed`, `…/TimeTotal`, `…/TimeRemaining` | number | `second` |
| `vendor/PrintJob/Uuid`, `…/Result`, `…/Source`, `…/SourceUser`, `…/SourceApplication`, `…/DatetimeStarted`, `…/DatetimeFinished` | string | – |
| `vendor/System/Name`, `…/Hostname`, `…/Firmware`, `…/Platform`, `…/Type`, `…/Variant`, `…/Guid`, `…/Country`, `…/Language` | string | – |
| `vendor/System/Uptime` | number | `second` |
| `vendor/System/MemoryUsage` | number | `one` |

### `events/notifications` – Alarme und Meldungen

Die Payload ist `NotificationEventDtoV1` mit dem Content Type `notificationeventdtov1`.

| `notificationId` | Level | Raised, solange |
|---|---|---|
| `printer-error` | Error | `printer/status` = `error` |
| `printer-maintenance` | Warning | `printer/status` = `maintenance` |
| `job-wait-user-action` | Warning | Job-Zustand `wait_user_action` |
| `job-paused` | Information | Job pausiert |
| `job-wait-cleanup` | Information | Druck fertig, Bauplatte muss geräumt werden |
| `log-{type_id}` | Information | Neuer Eintrag im Ereignisprotokoll des Druckers (nur Raised) |

Endet ein Zustand, folgt ein `Reset` mit derselben `correlationId`. Wird der Drucker unerreichbar, setzt der
Adapter alle offenen Zustände zurück.

## Status der Topics

Die `umati/`-Topics stehen alle im Binding. `vendor/` ist im Binding als Ebene für herstellerspezifische
Werte vorgesehen. Die einzelnen Pfade darunter und der neue Dienst sind aber **ein Vorschlag**. Sie werden im
Issue abgestimmt, siehe [`docs/issue-draft.md`](docs/issue-draft.md). `contracts/mqtt` im Playground wird nicht
geändert.

## Annahmen

- Geprüft gegen einen Ultimaker 3 mit Firmware 5.3.0. Fehlende Felder anderer Firmware werden übersprungen.
- `heads[].fan` ist dort ein Anteil 0..1. Werte über 1 werden als Prozent behandelt.
- Das Ereignisprotokoll schreibt seine Zeit ohne Zone in UTC. Die Uhr des Druckers läuft in UTC.
- `materials/{GUID}` liefert unter Firmware 5 das XML als JSON-String. Beide Formen werden gelesen.
- Nicht publiziert: `heads[].jerk` (bei Ultimaker eine Geschwindigkeit, kein Ruck im Sinne des Binding),
  Netznamen (SSIDs), Kamera, das Systemprotokoll und das gesamte Material-XML.

## Smart Factory Host (SFH)

Der Adapter ist als SFH-App 129 („Pleiades - Ultimaker 3 Adapter“) veröffentlicht.

- `app-definition.json`: AppDefinition 1.2.1, ein Container mit `/health` als Readiness- und Liveness-Probe,
  ohne Reverse Proxy.
- Values, pro Deployment überschreibbar: `printerUrl`, `serialNumber`, `mqttUrl`, `pollIntervalSeconds`.
- `appversion-0.1.0.json`: das daraus erzeugte AppVersionDto der Version 0.1.0 (versionId 5156).
- Image: `core.harbor.smartfactoryhost.com/secondary-maroon-stingray-129/ultimaker-adapter:<semver>`,
  gebaut mit `docker build --platform linux/amd64`.
- Das SFH muss Drucker und Broker erreichen. Kennt sein DNS den Namen des Brokers nicht, setze `mqttUrl`
  beim Deploy auf die IP-Adresse.
