> **Überholt (2026-11-18):** Mit dem Datenmodell 0.17.1 auf Playground-`main` (#82) gibt es `vendor/` nicht mehr;
> herstellereigene Signale liegen unter `oem/`. Der Adapter publiziert ab 0.2.0 unter `oem/Ultimaker/…`.

# Entwurf: Issue für united-machining-solutions/Pleiades.Playground

> Nur ein Entwurf. Er wird erst geöffnet, wenn du ausdrücklich zustimmst (`gh issue create`).

**Titel:** Proposal: Ultimaker 3 adapter (3D printer as a machine) and its vendor topics

**Body:**

## What the values are about

An Ultimaker 3 3D printer on the local network, published as a machine
`machines/{SerialNumber}/` so that it appears on the dashboard next to the simulated machine tools.

## Source and terms

The printer's local REST API (`http://<printer>/api/v1`, read-only GET, no authentication). The printer
belongs to the participant who runs the adapter. No third-party terms apply.

## Topics

Topics from the binding, unchanged:

- `umati/Connection/State`
- `umati/Connection/Heartbeat`
- `umati/State/MachineryItemState`
- `umati/State/MachineryOperationMode`
- `umati/Channel/1/ChannelState`
- `umati/Production/ActiveProgram`

They are mapped from the printer status and the job state. The mapping table is in the adapter README.

**Proposed** below `vendor/`, all in SI units of the binding. Indices count from 1:

| Topic | Kind | Unit |
|---|---|---|
| `vendor/Printer/Status` | string | – |
| `vendor/Bed/Temperature`, `vendor/Bed/TargetTemperature` | number | `degreeCelsius` |
| `vendor/Bed/PreHeatActive` | boolean | – |
| `vendor/Bed/Type` | string | – |
| `vendor/Head/{n}/Position/{X,Y,Z}` | number | `metre` |
| `vendor/Head/{n}/MaxSpeed/{X,Y,Z}` | number | `metrePerSecond` |
| `vendor/Head/{n}/Acceleration` | number | `metrePerSecondSquared` |
| `vendor/Head/{n}/Fan` | number | `one` |
| `vendor/Head/{n}/Extruder/{m}/Hotend/{Temperature,TargetTemperature,MaxTemperatureExposed}` | number | `degreeCelsius` |
| `vendor/Head/{n}/Extruder/{m}/Hotend/MaterialExtruded` | number | `metre` |
| `vendor/Head/{n}/Extruder/{m}/Hotend/TimeSpentHot` | number | `second` |
| `vendor/Head/{n}/Extruder/{m}/Hotend/{Id,Serial}` | string | – |
| `vendor/Head/{n}/Extruder/{m}/Hotend/Offset/State` | string | – |
| `vendor/Head/{n}/Extruder/{m}/Hotend/Offset/{X,Y,Z}` | number | `metre` |
| `vendor/Head/{n}/Extruder/{m}/Feeder/MaxSpeed` | number | `metrePerSecond` |
| `vendor/Head/{n}/Extruder/{m}/Feeder/Acceleration` | number | `metrePerSecondSquared` |
| `vendor/Head/{n}/Extruder/{m}/Material/{Guid,Brand,Type,Color,ColorCode}` | string | – |
| `vendor/Head/{n}/Extruder/{m}/Material/LengthRemaining` | number | `metre` |
| `vendor/Network/{Wifi,Ethernet}/Connected` | boolean | – |
| `vendor/Led/Hue` | number | `radian` |
| `vendor/Led/{Saturation,Brightness}` | number | `one` |
| `vendor/PrintJob/State` | string | – |
| `vendor/PrintJob/Progress` | number | `one` |
| `vendor/PrintJob/{TimeElapsed,TimeTotal,TimeRemaining}` | number | `second` |
| `vendor/PrintJob/{Uuid,Result,Source,SourceUser,SourceApplication,DatetimeStarted,DatetimeFinished}` | string | – |
| `vendor/System/{Name,Hostname,Firmware,Platform,Type,Variant,Guid,Country,Language}` | string | – |
| `vendor/System/Uptime` | number | `second` |
| `vendor/System/MemoryUsage` | number | `one` |

Notifications go to `events/notifications` (MQTT 5, content type `notificationeventdtov1`). Conditions are
raised and reset with the same correlation id: printer error (Error), maintenance (Warning), waiting for a
user action (Warning), paused (Information), waiting for cleanup (Information). New entries of the printer's
event log are sent as Information, raised only.

Open question: is `Production/ActiveProgram` the right place for the name of a print job?

## Where the adapter lives, and what the stack needs

- A new service, written in TypeScript (Node.js ≥ 22.18, `mqtt` 5.x). It currently lives in its own
  repository with its own Dockerfile and compose file. It could move to `apps/ultimaker-adapter` in
  the workspace, with a `compose.yaml` entry like `genui-mcp`, under a profile because it needs a real
  printer.
- No change to the persistence. `machines/+/vendor/#` and `machines/+/events/#` are already subscribed.
- No change to `contracts/mqtt` beyond, optionally, adding rows to "Example topics".
