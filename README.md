# Pleiades Ultimaker Adapter

Ein Adapter, der die Betriebsdaten eines **Ultimaker 3** über dessen lokale REST-API
(`http://<drucker>/api/v1`) liest und nach dem
[MQTT-Binding des Pleiades Playground](https://github.com/united-machining-solutions/Pleiades.Playground/blob/main/contracts/mqtt/README.md)
(„Machines: the binding of the data model“, umati-Datenmodell **0.17.1**) auf den Broker publiziert. Der Drucker
erscheint damit als Maschine `machines/ultimaker_UM3_{SERIAL_NUMBER}` im Pleiades-Stack.

**Herkunft der Daten:** Es ist der eigene Drucker des Betreibers im LAN (Standard: `192.168.100.27`). Der Adapter
liest nur. Lesende Aufrufe der Ultimaker-API brauchen keine Anmeldung. Es gelten keine Nutzungsbedingungen Dritter.

**Verhältnis zur Ultimaker-Telemetrie des Playground:** Der Playground bringt seit #148 einen eigenen Adapter mit
([`contracts/ultimaker/telemetry.md`](https://github.com/united-machining-solutions/Pleiades.Playground/blob/main/contracts/ultimaker/telemetry.md)).
Die Signale, die beide publizieren, liegen hier auf denselben Pfaden unter `oem/Ultimaker/…`, eine Karte liest beide
gleich. Dieser Adapter liefert zusätzlich Materialien, Druckkerne, Jobname, Restzeit, Firmware und die Alarme als
`Notification.ActiveAlerts` mit CloudEvents. **Lest nicht beide Adapter denselben Drucker**, sonst steht er zweimal im
Stack.

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
  Drucker. Setze dafür `PRINTER_URL=http://mock-printer:8081` – und nur gegen einen lokalen Broker.

Ohne Docker (Node.js ≥ 22.18): `npm ci && npm start`. Tests: `npm test`, Typprüfung: `npm run typecheck`.

## Einstellungen (Umgebung)

| Name | Standard | Bedeutung |
|---|---|---|
| `PRINTER_URL` | `http://192.168.100.27` | Basis-URL des Druckers |
| `SERIAL_NUMBER` | `UM3-01` | `Identification.SerialNumber`, dritter Teil der Maschinen-ID |
| `MODEL` | `UM3` | `Identification.Model`, zweiter Teil der Maschinen-ID |
| `PRODUCT_INSTANCE_URI` | leer | Global eindeutige ID; leer: `https://ultimaker.com/{MODEL}/{SERIAL_NUMBER}` |
| `MQTT_URL` | `mqtt://host.docker.internal:1883` | Broker |
| `MQTT_USER`, `MQTT_PASSWORD` | leer | Anmeldung am Broker, falls nötig |
| `MQTT_CLIENT_ID` | `ultimaker-adapter-{Maschinen-ID}` | Client-ID am Broker |
| `DNS_SERVER` | `8.8.8.8` | DNS des Containers (nur Compose). Für Broker mit LAN-Namen (z. B. `*.internal`) den DNS des LANs eintragen, siehe `resolvectl dns` |
| `POLL_INTERVAL_SECONDS` | `5` | Abfrageintervall des Druckers |
| `HEARTBEAT_INTERVAL_SECONDS` | `10` | Lebenszeichen, eigener Timer |

Die Maschinen-ID bildet der Adapter nach der Regel des Binding aus `ManufacturerUri` (`https://ultimaker.com` →
`ultimaker`), `MODEL` und `SERIAL_NUMBER`: `SERIAL_NUMBER=Dave` ergibt `ultimaker_UM3_Dave`.

## Verhalten

- Der Adapter fragt alle 5 s `printer`, `printer/status`, `print_job` und `history/events` ab, alle 60 s
  `system`, und einmal je Material `materials/{GUID}`.
- Jede Nachricht hat QoS 1 und den MQTT-5-Content-Type `application/json`. Werte und Manifest sind retained, Events
  nicht (`application/cloudevents+json; charset=utf-8`).
- **Verbindungsfolge:** Beim Start `Connection/State` = `Initializing`, dann das Manifest, die Identifikation, die
  Elemente von `Core`, die der Drucker nicht hat, als `null`, alle bekannten Werte und erst dann `Running`. Nach
  jedem Reconnect dasselbe ohne zweites `Initializing`. Vorher geht nichts anderes raus, auch kein Heartbeat.
- Ein Wert geht raus, wenn er sich ändert. Meldet der Drucker einen Wert nicht mehr (z. B. Material nach dem
  Entladen), geht er einmal als `null` raus. `timestamp` ist der Zeitpunkt der Abfrage in UTC
  (`"timestampSource": "adapter"`).
- Antwortet der Drucker nicht, `CommunicationFault`; die Werte bleiben stehen, nur der Heartbeat läuft weiter.
  Antwortet er wieder, gehen alle Werte neu raus, dann `Running`. Bei sauberem Stopp `Shutdown`. Der Last Will setzt
  `CommunicationFault`.
- **Heartbeat:** `Connection/Heartbeat` zählt alle 10 s ab 1, ohne Einheit, unabhängig vom Drucker.
- Zahlen werden **einmal im Adapter** in die Einheit des Katalogs umgerechnet: mm → `metre`, Prozent → `one`
  (1.0 = 100 %), Temperaturen in `degreeCelsius`.
- Events warten in einer Outbox (max. 10 000) und gehen nach der Verbindungsfolge in Reihenfolge raus.
- `/health` auf Port 8080 antwortet mit 200, solange die Verbindung zum Broker steht. Der Healthcheck des Images
  prüft das.

## Topics

Alle Topics liegen unter `machines/ultimaker_{MODEL}_{SERIAL_NUMBER}/`.

### `umati/` – Elemente des Modells (Profil `Core`)

| Topic | Art | Quelle / Abbildung |
|---|---|---|
| `umati/Manifest` | Manifest | Modell 0.17.1, Profil `Core`, alle Elemente, Signale und Events |
| `umati/Identification/{Manufacturer,SerialNumber,ProductInstanceUri,ManufacturerUri,Model}` | string | `Ultimaker`, `SERIAL_NUMBER`, …, `https://ultimaker.com`, `MODEL` |
| `umati/Identification/{ProductCode,YearOfConstruction}`, `umati/State/FeedOverride`, `umati/OperationCounters/PowerOnDuration` | `null` | `"available": false` |
| `umati/Connection/State` | enum | `Initializing`, `Running`, `CommunicationFault`, `Shutdown` |
| `umati/Connection/Heartbeat` | integer | Zähler ab 1 |
| `umati/State/Status` | Snapshot | `MachineryItemState`: `printing` + aktiver Job → `Executing`; `idle`, pausiert → `NotExecuting`; `booting` → `NotAvailable`; `error`, `maintenance` und Unbekanntes → `OutOfService`. `MachineryOperationMode`: aktiver oder pausierter Job → `Processing`; `wait_cleanup` → `Setup`; `maintenance` → `Maintenance`; sonst `None` |
| `umati/Notification/ActiveAlerts` | Liste | Stehende Alarme, siehe unten |

### `oem/` – Signale des Herstellers (Präfix `x-ultimaker-com`)

Im Manifest heißt ein Signal `x-ultimaker-com.Ultimaker.<Pfad>`, mit Typ, Einheit und Beschreibung. Die mit * markierten
Pfade publiziert die Ultimaker-Telemetrie des Playground genauso.

| Topic | Art | Einheit |
|---|---|---|
| `oem/Ultimaker/PrinterStatus` * | string | – (`idle`, `printing`, `error`, `maintenance`, `booting`) |
| `oem/Ultimaker/Bed/Temperature`, `…/TargetTemperature` * | number | `degreeCelsius` |
| `oem/Ultimaker/Bed/Type` | string | – |
| `oem/Ultimaker/Position/{X,Y,Z}` * | number | `metre` |
| `oem/Ultimaker/FanFraction` * | number | `one` |
| `oem/Ultimaker/Extruder/{0,1}/Temperature`, `…/TargetTemperature` * | number | `degreeCelsius` |
| `oem/Ultimaker/Extruder/{0,1}/MaterialRemainingLength` * | number | `metre` (nur wenn bekannt) |
| `oem/Ultimaker/Extruder/{0,1}/HotendId` | string | – (z. B. `AA 0.4`) |
| `oem/Ultimaker/Extruder/{0,1}/MaterialBrand`, `…/MaterialType`, `…/MaterialColor`, `…/MaterialColorCode` | string | – (nur mit geladenem Material) |
| `oem/Ultimaker/Print/State` * | string | – (`none`, `pre_print`, `printing`, `paused`, `wait_cleanup`, …) |
| `oem/Ultimaker/Print/JobId`, `…/Result` * | string | – |
| `oem/Ultimaker/Print/Name` | string | – (Dateiname des Jobs) |
| `oem/Ultimaker/Print/Progress` * | number | `one` |
| `oem/Ultimaker/Print/TimeElapsed`, `…/TimeTotal` *, `…/TimeRemaining` | number | `second` |
| `oem/Ultimaker/System/Firmware` | string | – |

Extruder zählen ab 0, wie der Drucker. Meldet ein Drucker mehr als zwei, kommt vorher ein neues Manifest.

### `events/notifications` – Alarme und Meldungen

CloudEvents 1.0 (structured mode): `source` ist die `ProductInstanceUri`, `sequence` der Start des Adapters und ein
zwölfstelliger Zähler ab 1, `dataschema` `urn:umati2:datamodel:0.17.1:event.schema.json`.

| `ErrorCode` | Event | `Severity` (NE 107) | Wann |
|---|---|---|---|
| `printer-error` | `AlertRaised` / `AlertCleared` | `Failure` | solange `printer/status` = `error` |
| `printer-maintenance` | `AlertRaised` / `AlertCleared` | `CheckFunction` | solange `printer/status` = `maintenance` |
| `job-wait-user-action` | `AlertRaised` / `AlertCleared` | `CheckFunction` | solange der Job auf den Bediener wartet |
| `job-wait-cleanup` | `NotificationEvent` | – | einmal, wenn der Druck fertig ist und die Bauplatte geräumt werden muss |
| `{type_id}` | `NotificationEvent` | – | neuer Eintrag im Ereignisprotokoll des Druckers |

Ein Alarm hat die Felder `Id`, `ErrorCode`, `Message`, `Severity` und `Time`. `Notification/ActiveAlerts` geht vor den
Events raus, die die Liste ändern. Ist der Drucker nicht erreichbar, bleiben die Alarme stehen.

## Annahmen

- Geprüft gegen einen Ultimaker 3 mit Firmware 5.3.0. Fehlende Felder anderer Firmware werden übersprungen.
- `heads[].fan` ist dort ein Anteil 0..1. Werte über 1 werden als Prozent behandelt.
- Das Ereignisprotokoll schreibt seine Zeit ohne Zone in UTC. Die Uhr des Druckers läuft in UTC.
- `materials/{GUID}` liefert unter Firmware 5 das XML als JSON-String. Beide Formen werden gelesen.
- Welcher Zustand welche `Severity` bekommt, ist eine Annahme dieses Adapters; das Modell schreibt keine vor.
- Nicht publiziert: wer den Job geschickt hat (`source_user`), Netznamen (SSIDs), Kamera, das Systemprotokoll und
  das gesamte Material-XML.
- Gegen die JSON-Schemas des Modells ist nicht geprüft: Das Repository des Modells braucht einen Zugang. Die Formate
  folgen dem C#-Code des Playground (`Pleiades.Playground.Mqtt.Extensions.Machines`, Cutting-Adapter).

## Smart Factory Host (SFH)

Der Adapter ist als SFH-App 129 („Pleiades - Ultimaker 3 Adapter“) veröffentlicht.

- `app-definition.json`: AppDefinition 1.2.1, ein Container mit `/health` als Readiness- und Liveness-Probe,
  ohne Reverse Proxy.
- Values, pro Deployment überschreibbar: `printerUrl`, `serialNumber`, `mqttUrl`, `pollIntervalSeconds`.
- `appversion-0.1.0.json`: AppVersionDto der Version 0.1.0 (versionId 5156), altes Binding (`machines/{SERIAL_NUMBER}`,
  `vendor/`). Der Stack liest es seit dem 18.11. nicht mehr.
- `appversion-0.2.0.json`: AppVersionDto der Version 0.2.0 (versionId 5175), Datenmodell 0.17.1.
- Image: `core.harbor.smartfactoryhost.com/secondary-maroon-stingray-129/ultimaker-adapter:<semver>`,
  gebaut mit `docker build --platform linux/amd64`.
- Das SFH muss Drucker und Broker erreichen. Kennt sein DNS den Namen des Brokers nicht, setze `mqttUrl`
  beim Deploy auf die IP-Adresse.
