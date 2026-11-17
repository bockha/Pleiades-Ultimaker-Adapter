// Every setting comes from the environment. The names are listed in .env.example.

export type Config = {
  /** Base URL of the printer's local API, without a trailing slash. */
  printerUrl: string
  /** The machine id in every topic: machines/{SerialNumber}/... */
  serialNumber: string
  mqttUrl: string
  mqttUser: string | undefined
  mqttPassword: string | undefined
  mqttClientId: string
  pollIntervalMs: number
  heartbeatIntervalMs: number
  /** An unchanged value is sent again after this time, so a reader always finds a recent one. */
  republishMs: number
  httpTimeoutMs: number
  /** Port of the liveness endpoint /health. */
  port: number
}

function seconds(name: string, usual: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name]
  if (raw === undefined || raw === "") return usual * 1000
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of seconds`)
  return value * 1000
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const serialNumber = env.SERIAL_NUMBER?.trim() || "UM3"
  if (/[/+#]/.test(serialNumber)) throw new Error("SERIAL_NUMBER must not contain '/', '+' or '#'")
  return {
    printerUrl: (env.PRINTER_URL?.trim() || "http://192.168.100.27").replace(/\/+$/, ""),
    serialNumber,
    mqttUrl: env.MQTT_URL?.trim() || "mqtt://localhost:1883",
    mqttUser: env.MQTT_USER || undefined,
    mqttPassword: env.MQTT_PASSWORD || undefined,
    mqttClientId: env.MQTT_CLIENT_ID?.trim() || `ultimaker-adapter-${serialNumber}`,
    pollIntervalMs: seconds("POLL_INTERVAL_SECONDS", 5, env),
    heartbeatIntervalMs: seconds("HEARTBEAT_INTERVAL_SECONDS", 10, env),
    republishMs: seconds("REPUBLISH_SECONDS", 60, env),
    httpTimeoutMs: seconds("HTTP_TIMEOUT_SECONDS", 4, env),
    port: Number(env.PORT || 8080),
  }
}
