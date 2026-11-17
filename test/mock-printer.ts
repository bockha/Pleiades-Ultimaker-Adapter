// A stand-in for the local API of an Ultimaker 3, for trying the adapter without a printer.
//   node test/mock-printer.ts [port]      then PRINTER_URL=http://localhost:8081
// It runs through idle, a print, a pause, the end of the print and an error, over and over.
import { createServer } from "node:http"

const port = Number(process.argv[2] ?? 8081)
const started = Date.now()
const phases = [
  { status: "idle", job: null, seconds: 20 },
  { status: "printing", job: "pre_print", seconds: 15 },
  { status: "printing", job: "printing", seconds: 60 },
  { status: "printing", job: "paused", seconds: 15 },
  { status: "printing", job: "printing", seconds: 30 },
  { status: "printing", job: "wait_cleanup", seconds: 20 },
  { status: "error", job: null, seconds: 15 },
] as const
const cycle = phases.reduce((sum, p) => sum + p.seconds, 0)

function now() {
  let t = ((Date.now() - started) / 1000) % cycle
  for (const p of phases) {
    if (t < p.seconds) return p
    t -= p.seconds
  }
  return phases[0]
}

const hot = () => now().job !== null
const wobble = (base: number, by: number) => Math.round((base + (Math.random() - 0.5) * by) * 10) / 10
const events: Array<object> = [{ time: "2026-11-17T08:00:00", type_id: 65536, message: "System started", parameters: [] }]
let last = now()

function answer(path: string): unknown {
  const p = now()
  if (p !== last) {
    events.unshift({ time: new Date().toISOString().slice(0, 19), type_id: 131072, message: `Phase ${p.status}/${p.job ?? "none"}`, parameters: [] })
    last = p
  }
  const elapsed = ((Date.now() - started) / 1000) % cycle
  switch (path) {
    case "/api/v1/printer/status":
      return p.status
    case "/api/v1/printer":
      return {
        status: p.status,
        bed: { temperature: { current: hot() ? wobble(60, 0.6) : wobble(24, 0.2), target: hot() ? 60 : 0 }, pre_heat: { active: false }, type: "glass" },
        heads: [{
          position: { x: wobble(100, 80), y: wobble(100, 80), z: 12.3 },
          max_speed: { x: 300, y: 300, z: 40 },
          acceleration: 3000,
          fan: hot() ? 1.0 : 0,
          extruders: [
            { hotend: { id: "AA 0.4", serial: "1234abcd", temperature: { current: hot() ? wobble(210, 1) : wobble(25, 0.2), target: hot() ? 210 : 0 },
                statistics: { material_extruded: 512345, max_temperature_exposed: 260, time_spent_hot: 987654, last_material_guid: "506c9f0d-e3aa-4bd4-b2d2-23e2425b1aa9" } },
              active_material: { GUID: "506c9f0d-e3aa-4bd4-b2d2-23e2425b1aa9", length_remaining: 42000 } },
            { hotend: { id: "BB 0.4", serial: "5678efgh", temperature: { current: wobble(25, 0.2), target: 0 } },
              active_material: { GUID: "", length_remaining: -1 } },
          ],
        }],
        led: { hue: 0, saturation: 0, brightness: 100 },
      }
    case "/api/v1/print_job":
      if (p.job === null) return undefined
      return { name: "UM3_bracket.gcode", uuid: "c0ffee00-0000-4000-8000-000000000001", state: p.job, result: "", progress: Math.min(1, elapsed / cycle),
        time_elapsed: Math.round(elapsed), time_total: cycle, source: "WEB_API", source_user: "demo", source_application: "Cura", datetime_started: "2026-11-17T09:00:00" }
    case "/api/v1/system":
      return { name: "Ultimaker-3-Mock", hostname: "ultimakersystem-mock", firmware: "5.2.11.20190503", platform: "Linux", type: "3D printer", variant: "Ultimaker 3", uptime: Math.round(process.uptime()) + 3600, memory: { total: 1031516160, used: 315432960 } }
    case "/api/v1/history/events":
      return events.slice(0, 20)
    case "/api/v1/materials/506c9f0d-e3aa-4bd4-b2d2-23e2425b1aa9":
      return `<?xml version="1.0"?><fdmmaterial xmlns="http://www.ultimaker.com/material"><metadata><name><brand>Ultimaker</brand><material>PLA</material><color>Silver Metallic</color></name></metadata></fdmmaterial>`
  }
  return undefined
}

createServer((request, response) => {
  const body = answer((request.url ?? "").split("?")[0] ?? "")
  if (body === undefined) response.writeHead(404).end()
  else if (typeof body === "string" && body.startsWith("<?xml")) response.writeHead(200, { "Content-Type": "application/xml" }).end(body)
  else response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body))
}).listen(port, () => console.log(`mock Ultimaker 3 on http://localhost:${port}`))
