// Every setting comes from the environment. The names are listed in .env.example.

export type Config = {
  /** Base URL of the printer's local API, without a trailing slash. */
  printerUrl: string
  /** Identification.SerialNumber; with the model it forms the machine id ultimaker_<model>_<serial>. */
  serialNumber: string
  /** Identification.Model. */
  model: string
  /** Identification.ProductInstanceUri; empty for https://ultimaker.com/<model>/<serial>. */
  productInstanceUri: string | undefined
  mqttUrl: string
  mqttUser: string | undefined
  mqttPassword: string | undefined
  /** Empty for ultimaker-adapter-<machine id>. */
  mqttClientId: string | undefined
  pollIntervalMs: number
  heartbeatIntervalMs: number
  httpTimeoutMs: number
  /** Port of the liveness endpoint /health. */
  port: number
}

/** Who makes the printer, as Identification.Manufacturer and ManufacturerUri say. */
export const MANUFACTURER = "Ultimaker"
export const MANUFACTURER_URI = "https://ultimaker.com"

function seconds(name: string, usual: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name]
  if (raw === undefined || raw === "") return usual * 1000
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of seconds`)
  return value * 1000
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    printerUrl: (env.PRINTER_URL?.trim() || "http://192.168.100.27").replace(/\/+$/, ""),
    serialNumber: env.SERIAL_NUMBER?.trim() || "UM3-01",
    model: env.MODEL?.trim() || "UM3",
    productInstanceUri: env.PRODUCT_INSTANCE_URI?.trim() || undefined,
    mqttUrl: env.MQTT_URL?.trim() || "mqtt://localhost:1883",
    mqttUser: env.MQTT_USER || undefined,
    mqttPassword: env.MQTT_PASSWORD || undefined,
    mqttClientId: env.MQTT_CLIENT_ID?.trim() || undefined,
    pollIntervalMs: seconds("POLL_INTERVAL_SECONDS", 5, env),
    heartbeatIntervalMs: seconds("HEARTBEAT_INTERVAL_SECONDS", 10, env),
    httpTimeoutMs: seconds("HTTP_TIMEOUT_SECONDS", 4, env),
    port: Number(env.PORT || 8080),
  }
}
