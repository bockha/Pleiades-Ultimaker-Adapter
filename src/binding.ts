// The MQTT binding of machines to the umati data model 0.17.1 (Pleiades.Playground contracts/mqtt,
// "Machines: the binding of the data model"): machine id, topics, value envelope, manifest and
// CloudEvents. It follows the shared C# implementation (Pleiades.Playground.Mqtt.Extensions.Machines).

import { randomUUID } from "node:crypto"

export const MODEL_VERSION = "0.17.1"
export const BINDING_VERSION = "0.1.0-draft"
/** The MQTT 5 content type of a value and of the manifest. */
export const CONTENT_TYPE = "application/json"
/** The MQTT 5 content type of an event. */
export const EVENT_CONTENT_TYPE = "application/cloudevents+json; charset=utf-8"
export const EVENT_DATA_SCHEMA = `urn:umati2:datamodel:${MODEL_VERSION}:event.schema.json`

export const CONNECTION_STATE = "Connection.State"
export const HEARTBEAT = "Connection.Heartbeat"
export const STATUS = "State.Status"
export const ACTIVE_ALERTS = "Notification.ActiveAlerts"

export type AdapterState = "Initializing" | "Running" | "CommunicationFault" | "Shutdown"
/** The model has no value for an adapter that is gone; CommunicationFault comes closest. */
export const LAST_WILL_STATE: AdapterState = "CommunicationFault"

/** A unit of the catalogue of the model: its UN/ECE code and its name, which goes on the wire. */
export type Unit = { code: string; name: string }
export const UNITS = {
  one: { code: "C62", name: "one" },
  second: { code: "SEC", name: "second" },
  metre: { code: "MTR", name: "metre" },
  degreeCelsius: { code: "CEL", name: "degreeCelsius" },
} as const satisfies Record<string, Unit>

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * A value of an element: a path of the model (State.Status) or of a signal of the manufacturer
 * (x-<domain>.<path>). `value` null means "not available right now"; `unit` is the name of the unit
 * of a number.
 */
export type MachineValue = { path: string; value: Json; timestamp: Date; unit?: string }

/** Who the machine is, and what follows from it by the rules of the binding. */
export class Identity {
  readonly manufacturer: string
  readonly manufacturerUri: string
  readonly model: string
  readonly serialNumber: string
  readonly productInstanceUri: string
  readonly machineId: string
  readonly prefix: string

  constructor(options: { manufacturer: string; manufacturerUri: string; model: string; serialNumber: string; productInstanceUri?: string }) {
    this.manufacturer = options.manufacturer
    this.manufacturerUri = options.manufacturerUri
    this.model = options.model
    this.serialNumber = options.serialNumber
    this.productInstanceUri = options.productInstanceUri?.trim() ||
      `${options.manufacturerUri.replace(/\/+$/, "")}/${encodeURIComponent(options.model)}/${encodeURIComponent(options.serialNumber)}`
    this.machineId = machineId(options.manufacturerUri, options.model, options.serialNumber)
    this.prefix = extensionPrefix(domainOf(options.manufacturerUri))
  }

  /** The path of a signal of the manufacturer: the prefix, a dot and the path below it. */
  signal(relative: string): string {
    return `${this.prefix}.${relative}`
  }

  /** The values of Identification every adapter delivers. */
  values(timestamp: Date): Array<MachineValue> {
    return [
      { path: "Identification.Manufacturer", value: this.manufacturer, timestamp },
      { path: "Identification.SerialNumber", value: this.serialNumber, timestamp },
      { path: "Identification.ProductInstanceUri", value: this.productInstanceUri, timestamp },
      { path: "Identification.ManufacturerUri", value: this.manufacturerUri, timestamp },
      { path: "Identification.Model", value: this.model, timestamp },
    ]
  }
}

/** The domain of a web address, without a leading www., in lower case. */
export function domainOf(uri: string): string {
  // Not new URL(): it writes a domain with umlauts in punycode, the .NET Uri of the Playground does not.
  const host = (/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]+)/i.exec(uri.trim())?.[1] ?? uri.trim()).toLowerCase()
  return host.startsWith("www.") ? host.slice(4) : host
}

/**
 * One part of a machine id: ä, ö, ü, ß written out, other accents dropped, every character but
 * A-Z, a-z, 0-9 and - a -, several - one, none at the start or end, at most 64 characters, an
 * empty part "unknown".
 */
export function machineIdPart(text: string | undefined): string {
  let part = (text ?? "")
    .replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue")
    .replaceAll("Ä", "Ae").replaceAll("Ö", "Oe").replaceAll("Ü", "Ue")
    .replaceAll("ß", "ss")
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replace(/[^A-Za-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  if (part.length > 64) part = part.slice(0, 64).replace(/-+$/, "")
  return part || "unknown"
}

/** `<manufacturer>_<model>_<serial number>`; the manufacturer is the domain without its top-level domain. */
export function machineId(manufacturerUri: string, model: string | undefined, serialNumber: string | undefined): string {
  let manufacturer = domainOf(manufacturerUri)
  const lastDot = manufacturer.lastIndexOf(".")
  if (lastDot > 0) manufacturer = manufacturer.slice(0, lastDot)
  return [machineIdPart(manufacturer), machineIdPart(model), machineIdPart(serialNumber)].join("_")
}

/** The prefix of the signals of a manufacturer, x-<domain> with - for every dot. */
export function extensionPrefix(domain: string): string {
  return `x-${domain.trim().toLowerCase().replaceAll(".", "-")}`
}

/** The topic of an element: a model path below umati/, a signal x-<domain>.<path> below oem/. */
export function topic(machine: string, path: string): string {
  if (path.startsWith("x-")) {
    const dot = path.indexOf(".")
    if (dot < 3 || !/^[a-z0-9-]+$/.test(path.slice(2, dot))) throw new Error(`'${path}' has no prefix x-<domain> of the model`)
    return `machines/${machine}/oem/${path.slice(dot + 1).replaceAll(".", "/")}`
  }
  return `machines/${machine}/umati/${path.replaceAll(".", "/")}`
}

export const manifestTopic = (machine: string) => `machines/${machine}/umati/Manifest`
export const notificationsTopic = (machine: string) => `machines/${machine}/events/notifications`

/** Source time in UTC, ISO 8601 with milliseconds and Z. */
export const timestampOf = (at: Date) => at.toISOString()

/** The value envelope {timestamp, value, unit?}; a unit only with a plain value. */
export function envelope(value: MachineValue): { timestamp: string; value: Json; unit?: string } {
  const out: { timestamp: string; value: Json; unit?: string } = { timestamp: timestampOf(value.timestamp), value: value.value }
  if (value.unit !== undefined && (value.value === null || typeof value.value !== "object")) out.unit = value.unit
  return out
}

/** What the manifest says about a signal of the manufacturer. */
export type Signal = { type: "string" | "number" | "integer" | "boolean"; unit?: Unit; description: string }
export type Element = { path: string; timestampSource?: "adapter" | "source"; signal?: Signal }

/** The elements of the profile Core of the model 0.17.1, in the order of its catalogue. */
export const CORE: ReadonlyArray<string> = [
  "Identification.Manufacturer", "Identification.SerialNumber", "Identification.ProductInstanceUri",
  "Identification.ManufacturerUri", "Identification.Model", "Identification.ProductCode", "Identification.YearOfConstruction",
  HEARTBEAT, CONNECTION_STATE, STATUS, "State.FeedOverride", ACTIVE_ALERTS, "OperationCounters.PowerOnDuration",
]
const ALWAYS_DELIVERED = new Set(CORE.slice(0, 5).concat([HEARTBEAT, CONNECTION_STATE]))

/**
 * The manifest of an adapter that declares the profile Core: the elements of Core it delivers, the
 * others of Core with "available": false, then its own elements and signals, then its events.
 */
export function manifest(identity: Identity, heartbeatSeconds: number, delivered: ReadonlyArray<Element>, events: ReadonlyArray<string>): { [key: string]: Json } {
  const byPath = new Map(delivered.map((e) => [e.path, e]))
  const element = (e: Element): { [key: string]: Json } => {
    const json: { [key: string]: Json } = { path: e.path, timestampSource: e.timestampSource ?? "adapter" }
    if (e.signal) {
      json.type = e.signal.type
      if (e.signal.unit) json.unit = { code: e.signal.unit.code, name: e.signal.unit.name }
      json.description = e.signal.description
    }
    return json
  }
  const elements: Array<Json> = CORE.map((path) => {
    const given = byPath.get(path)
    if (given) return element(given)
    return ALWAYS_DELIVERED.has(path) ? element({ path }) : { path, available: false }
  })
  for (const e of delivered) if (!CORE.includes(e.path)) elements.push(element(e))
  return {
    modelVersion: MODEL_VERSION,
    bindingVersion: BINDING_VERSION,
    machineId: identity.machineId,
    machine: { ProductInstanceUri: identity.productInstanceUri },
    profiles: ["Core"],
    heartbeatInterval: heartbeatSeconds,
    elements,
    events: events.map((path) => ({ path })),
  }
}

/** The paths a manifest names with "available": false: published once with value null. */
export function unavailable(m: { [key: string]: Json }): Array<string> {
  const elements = Array.isArray(m.elements) ? m.elements : []
  return elements.flatMap((e) =>
    e !== null && typeof e === "object" && !Array.isArray(e) && e.available === false && typeof e.path === "string" ? [e.path] : [])
}

/**
 * Builds the CloudEvents of one group of events: sequence is the start of the adapter, a dot and a
 * count of twelve digits from 1 without a gap.
 */
export class EventSequence {
  private readonly prefix: string
  private count = 0
  private readonly source: string

  constructor(source: string, start: Date) {
    this.source = source
    this.prefix = start.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  }

  next(type: string, time: Date, data: { [key: string]: Json }): { [key: string]: Json } {
    this.count += 1
    return {
      specversion: "1.0",
      id: randomUUID(),
      source: this.source,
      type,
      time: timestampOf(time),
      sequence: `${this.prefix}.${String(this.count).padStart(12, "0")}`,
      dataschema: EVENT_DATA_SCHEMA,
      data,
    }
  }
}
