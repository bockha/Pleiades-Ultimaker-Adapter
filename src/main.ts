// The adapter: polls the printer and publishes it below machines/ultimaker_<model>_<serial>/ by the
// MQTT binding of the data model 0.17.1. Connection/State says whether the printer answers;
// Connection/Heartbeat runs on a timer of its own, also while the printer does not answer.

import { createServer } from "node:http"

import mqtt from "mqtt"

import { ACTIVE_ALERTS, EventSequence, Identity, STATUS, manifest, notificationsTopic } from "./binding.ts"
import type { Element } from "./binding.ts"
import { MANUFACTURER, MANUFACTURER_URI, loadConfig } from "./config.ts"
import { DEFAULT_EXTRUDERS, extrudersOf, signals, valuesOf } from "./mapping.ts"
import { AlertTracker, EVENTS } from "./notifications.ts"
import type { NotificationOut } from "./notifications.ts"
import { MachinePublisher, lastWill } from "./publisher.ts"
import { UltimakerClient } from "./ultimaker.ts"
import type { Material, System } from "./ultimaker.ts"

const SYSTEM_EVERY_MS = 60_000
const MATERIAL_RETRY_MS = 5 * 60_000

const config = loadConfig()
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)

const identity = new Identity({
  manufacturer: MANUFACTURER,
  manufacturerUri: MANUFACTURER_URI,
  model: config.model,
  serialNumber: config.serialNumber,
  productInstanceUri: config.productInstanceUri,
})
const clientId = config.mqttClientId ?? `ultimaker-adapter-${identity.machineId}`

let extruders = DEFAULT_EXTRUDERS
function manifestFor(count: number) {
  const elements: Array<Element> = [
    { path: STATUS },
    { path: ACTIVE_ALERTS },
    ...signals(count).map(([relative, signal]) => ({ path: identity.signal(relative), signal })),
  ]
  return manifest(identity, config.heartbeatIntervalMs / 1000, elements, EVENTS)
}

const printer = new UltimakerClient(config.printerUrl, config.httpTimeoutMs)
const client = mqtt.connect(config.mqttUrl, {
  protocolVersion: 5, // the content type is an MQTT 5 property
  clientId,
  username: config.mqttUser,
  password: config.mqttPassword,
  reconnectPeriod: 5000,
  connectTimeout: 10_000,
  will: lastWill(identity, new Date()),
})
const publisher = new MachinePublisher(client, identity, manifestFor(extruders), { log })
const alerts = new AlertTracker()
const notifications = new EventSequence(identity.productInstanceUri, new Date())

client.on("connect", () => {
  log(`MQTT connected to ${config.mqttUrl} as ${clientId}`)
  publisher.connected(new Date())
})
// The last will carries the time it is set: the next connect sets it anew.
client.on("reconnect", () => {
  client.options.will = lastWill(identity, new Date())
})
client.on("close", () => {
  publisher.disconnected()
  log("MQTT connection closed")
})
client.on("error", (error) => log(`MQTT error: ${error.message}`))

let system: System | null = null
let systemReadAt = 0
let eventLog = true
const materials = new Map<string, Material>()
const materialTried = new Map<string, number>()

async function readMaterials(guids: ReadonlyArray<string>) {
  for (const guid of guids) {
    if (materials.has(guid) || Date.now() - (materialTried.get(guid) ?? 0) < MATERIAL_RETRY_MS) continue
    materialTried.set(guid, Date.now())
    try {
      materials.set(guid, await printer.material(guid))
    } catch (error) {
      log(`material ${guid} not readable: ${(error as Error).message}`)
    }
  }
}

function sendEvents(events: ReadonlyArray<NotificationOut>) {
  for (const e of events) {
    publisher.event(notificationsTopic(identity.machineId), notifications.next(e.type, e.time, e.data))
    log(`${e.type} ${e.data.ErrorCode}: ${e.data.Message}`)
  }
}

async function poll() {
  try {
    const [status, state, job] = await Promise.all([printer.status(), printer.printer(), printer.printJob()])
    const at = new Date() // the time of the observation
    if (Date.now() - systemReadAt >= SYSTEM_EVERY_MS) {
      system = await printer.system().catch(() => system)
      systemReadAt = Date.now()
    }
    const guids = (state.heads ?? []).flatMap((h) => (h.extruders ?? []).flatMap((e) => e.active_material?.GUID || e.active_material?.guid || []))
    await readMaterials(guids)

    if (publisher.reached !== true) log(`printer ${config.printerUrl} answers, status ${status}`)

    // A printer with more extruders than the manifest names gets a new manifest before their values.
    if (extrudersOf(state) > extruders) {
      extruders = extrudersOf(state)
      publisher.updateManifest(manifestFor(extruders))
    }

    const events = alerts.update(status, job?.state, at)
    if (eventLog) {
      const entries = await printer.events().catch(() => undefined)
      if (entries === null) eventLog = false // this firmware has no event log
      else if (entries) events.push(...alerts.fromLog(entries, at))
    }
    const values = valuesOf({ status, printer: state, job, system, materials }, identity, at)
    values.push({ path: ACTIVE_ALERTS, value: alerts.list(), timestamp: at })
    // The list goes out before the events that change it.
    publisher.answered(values, at)
    sendEvents(events)
  } catch (error) {
    if (publisher.reached !== false) log(`printer ${config.printerUrl} does not answer: ${(error as Error).message}`)
    publisher.lost(new Date())
  } finally {
    pollTimer = setTimeout(poll, config.pollIntervalMs)
  }
}

let pollTimer = setTimeout(poll, 0)
const heartbeatTimer = setInterval(() => publisher.heartbeat(new Date()), config.heartbeatIntervalMs)

// Liveness: /health answers 200 while the adapter is connected to the broker.
const health = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end()
    return
  }
  const body = JSON.stringify({ mqtt: client.connected, printer: publisher.reached === true, machineId: identity.machineId })
  response.writeHead(client.connected ? 200 : 503, { "Content-Type": "application/json" }).end(body)
})
health.listen(config.port, () => log(`health on :${config.port}/health, printer ${config.printerUrl}, machine ${identity.machineId}`))

async function shutdown(signal: string) {
  log(`${signal}: stopping`)
  clearTimeout(pollTimer)
  clearInterval(heartbeatTimer)
  health.close()
  await publisher.shutdown(new Date())
  await client.endAsync().catch(() => undefined)
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
