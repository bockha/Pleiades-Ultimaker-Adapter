// The adapter: polls the printer, publishes its values by the MQTT binding, and says that it is
// there with Connection/State and Connection/Heartbeat on a timer of their own.

import { createServer } from "node:http"

import { loadConfig } from "./config.ts"
import { valuesOf } from "./mapping.ts"
import type { Value } from "./mapping.ts"
import { NotificationTracker } from "./notifications.ts"
import type { NotificationEvent } from "./notifications.ts"
import { ChangeFilter, Publisher } from "./publisher.ts"
import { UltimakerClient } from "./ultimaker.ts"
import type { Material, System } from "./ultimaker.ts"

const SYSTEM_EVERY_MS = 60_000
const MATERIAL_RETRY_MS = 5 * 60_000

const config = loadConfig()
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)

const printer = new UltimakerClient(config.printerUrl, config.httpTimeoutMs)
const publisher = new Publisher(config.mqttUrl, {
  clientId: config.mqttClientId,
  username: config.mqttUser,
  password: config.mqttPassword,
  serialNumber: config.serialNumber,
})
const filter = new ChangeFilter(config.republishMs)
const notifications = new NotificationTracker(config.serialNumber)

let printerOnline = false
let heartbeat = 0
let system: System | null = null
let systemReadAt = 0
let eventLog = true
const materials = new Map<string, Material>()
const materialTried = new Map<string, number>()

publisher.client.on("connect", () => {
  log(`MQTT connected to ${config.mqttUrl} as ${config.mqttClientId}`)
  filter.clear() // send everything again after a reconnect
  void signOfLife()
})
publisher.client.on("close", () => log("MQTT connection closed"))
publisher.client.on("error", (error) => log(`MQTT error: ${error.message}`))

async function send(values: ReadonlyArray<Value>, events: ReadonlyArray<NotificationEvent>, at: Date) {
  if (!publisher.connected) return
  const now = at.getTime()
  const due = values.filter((v) => filter.due(v.path, v.value, now))
  await Promise.all([
    ...due.map(async (v) => {
      await publisher.value(v, at)
      filter.sent(v.path, v.value, now)
    }),
    ...events.map(async (e) => {
      await publisher.notification(e)
      log(`notification ${e.action} ${e.level} ${e.notificationId}: ${e.title}`)
    }),
  ])
}

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

    if (!printerOnline) {
      printerOnline = true
      log(`printer ${config.printerUrl} reachable, status ${status}`)
      void signOfLife()
    }

    const events = notifications.update(status, job?.state, at)
    if (eventLog) {
      const entries = await printer.events().catch(() => undefined)
      if (entries === null) eventLog = false // this firmware has no event log
      else if (entries) events.push(...notifications.fromLog(entries, at))
    }
    await send(valuesOf({ status, printer: state, job, system, materials }), events, at)
  } catch (error) {
    if (printerOnline) {
      printerOnline = false
      log(`printer ${config.printerUrl} not reachable: ${(error as Error).message}`)
      const at = new Date()
      await send([], notifications.resetAll(at), at).catch(() => undefined)
      filter.clear()
      void signOfLife()
    }
  } finally {
    pollTimer = setTimeout(poll, config.pollIntervalMs)
  }
}

/**
 * Connection/State says whether the printer answers. Connection/Heartbeat counts up while it does,
 * so a reader takes the machine as silent 30 seconds after the printer stopped answering.
 */
async function signOfLife() {
  if (!publisher.connected) return
  const at = new Date()
  try {
    await publisher.value({ path: "umati/Connection/State", value: printerOnline ? "Connected" : "Disconnected" }, at)
    if (printerOnline) {
      heartbeat += 1
      await publisher.value({ path: "umati/Connection/Heartbeat", value: heartbeat, unit: "one" }, at)
    }
  } catch (error) {
    log(`sign of life not sent: ${(error as Error).message}`)
  }
}

let pollTimer = setTimeout(poll, 0)
const heartbeatTimer = setInterval(signOfLife, config.heartbeatIntervalMs)

// Liveness: /health answers 200 while the adapter is connected to the broker.
const health = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end()
    return
  }
  const body = JSON.stringify({ mqtt: publisher.connected, printer: printerOnline, serialNumber: config.serialNumber })
  response.writeHead(publisher.connected ? 200 : 503, { "Content-Type": "application/json" }).end(body)
})
health.listen(config.port, () => log(`health on :${config.port}/health, printer ${config.printerUrl}, machine ${config.serialNumber}`))

async function shutdown(signal: string) {
  log(`${signal}: stopping`)
  clearTimeout(pollTimer)
  clearInterval(heartbeatTimer)
  health.close()
  await publisher.close().catch(() => undefined)
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
