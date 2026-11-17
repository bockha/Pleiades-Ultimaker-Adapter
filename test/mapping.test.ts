import assert from "node:assert/strict"
import { test } from "node:test"

import { channelState, machineryItemState, machineryOperationMode, valuesOf } from "../src/mapping.ts"
import type { Value } from "../src/mapping.ts"
import { NotificationTracker, objectId, parseLogTime } from "../src/notifications.ts"
import { ChangeFilter, contentTypeOf, envelope } from "../src/publisher.ts"
import { parseMaterial } from "../src/ultimaker.ts"

const byPath = (values: Array<Value>) => new Map(values.map((v) => [v.path, v]))

test("states of a print map to the umati states the dashboard reads", () => {
  assert.equal(machineryItemState("printing", "printing"), "Executing")
  assert.equal(machineryItemState("printing", "paused"), "NotExecuting")
  assert.equal(machineryItemState("idle", undefined), "NotExecuting")
  assert.equal(machineryItemState("error", undefined), "OutOfService")
  assert.equal(machineryItemState("booting", undefined), "NotAvailable")
  assert.equal(machineryOperationMode("printing", "printing"), "Processing")
  assert.equal(machineryOperationMode("printing", "wait_cleanup"), "Setup")
  assert.equal(machineryOperationMode("maintenance", undefined), "Maintenance")
  assert.equal(machineryOperationMode("idle", undefined), "None")
  assert.equal(channelState("printing"), "Active")
  assert.equal(channelState("paused"), "Interrupted")
  assert.equal(channelState(undefined), "Reset")
})

test("values are converted once to SI units, indices count from 1", () => {
  const values = byPath(valuesOf({
    status: "printing",
    printer: {
      bed: { temperature: { current: 59.8, target: 60 } },
      heads: [{ position: { x: 120, y: 97.2, z: 1.5 }, max_speed: { x: 300 }, acceleration: 3000, fan: 50,
        extruders: [{ hotend: { temperature: { current: 210 }, statistics: { material_extruded: 2500, time_spent_hot: 60 } }, active_material: { GUID: "g", length_remaining: 1000 } }] }],
      led: { hue: 180, brightness: 100 },
    },
    job: { name: "part.gcode", state: "printing", progress: 0.25, time_elapsed: 100, time_total: 400 },
    system: { uptime: 3600, memory: { used: 1, total: 4 } },
    materials: new Map([["g", { brand: "Ultimaker", material: "PLA", color: "Black" }]]),
  }))
  assert.deepEqual(values.get("umati/State/MachineryItemState"), { path: "umati/State/MachineryItemState", value: "Executing" })
  assert.deepEqual(values.get("umati/Production/ActiveProgram")?.value, "part.gcode")
  assert.deepEqual(values.get("vendor/Bed/Temperature"), { path: "vendor/Bed/Temperature", value: 59.8, unit: "degreeCelsius" })
  assert.deepEqual(values.get("vendor/Head/1/Position/X"), { path: "vendor/Head/1/Position/X", value: 0.12, unit: "metre" })
  assert.equal(values.get("vendor/Head/1/Position/Y")?.value, 0.0972)
  assert.deepEqual(values.get("vendor/Head/1/MaxSpeed/X"), { path: "vendor/Head/1/MaxSpeed/X", value: 0.3, unit: "metrePerSecond" })
  assert.equal(values.get("vendor/Head/1/Fan")?.value, 0.5)
  assert.equal(values.get("vendor/Head/1/Extruder/1/Hotend/MaterialExtruded")?.value, 2.5)
  assert.equal(values.get("vendor/Head/1/Extruder/1/Material/LengthRemaining")?.value, 1)
  assert.equal(values.get("vendor/Head/1/Extruder/1/Material/Type")?.value, "PLA")
  assert.equal(values.get("vendor/PrintJob/TimeRemaining")?.value, 300)
  assert.equal(values.get("vendor/System/MemoryUsage")?.value, 0.25)
  assert.ok(Math.abs((values.get("vendor/Led/Hue")?.value as number) - Math.PI) < 1e-9)
  for (const v of values.values()) {
    if (typeof v.value === "number") assert.ok("unit" in v, `${v.path} has a unit`)
    assert.ok(!/[+#]/.test(v.path) && !v.path.includes("["), v.path)
  }
})

test("without a job the program is empty and the job state is none", () => {
  const values = byPath(valuesOf({ status: "idle", printer: {}, job: null, system: null, materials: new Map() }))
  assert.equal(values.get("umati/Production/ActiveProgram")?.value, "")
  assert.equal(values.get("vendor/PrintJob/State")?.value, "none")
  assert.equal(values.has("vendor/PrintJob/Progress"), false)
})

test("the envelope follows the binding", () => {
  const at = new Date("2026-11-17T09:15:00.120Z")
  assert.deepEqual(envelope({ path: "a", value: 0.82, unit: "one" }, at), { timestamp: "2026-11-17T09:15:00.120Z", value: 0.82, unit: "one" })
  assert.deepEqual(envelope({ path: "a", value: "Executing" }, at), { timestamp: "2026-11-17T09:15:00.120Z", value: "Executing" })
  assert.equal(contentTypeOf(1), "baseunitvaluedto")
  assert.equal(contentTypeOf("x"), "stringvaluedto")
  assert.equal(contentTypeOf(true), "booleanvaluedto")
})

test("an unchanged value is sent again only after the republish time", () => {
  const filter = new ChangeFilter(60_000)
  assert.ok(filter.due("p", 1, 0))
  filter.sent("p", 1, 0)
  assert.ok(!filter.due("p", 1, 59_999))
  assert.ok(filter.due("p", 2, 1))
  assert.ok(filter.due("p", 1, 60_000))
})

test("a condition is raised and reset with one correlation id", () => {
  const tracker = new NotificationTracker("UM3")
  const at = new Date("2026-11-17T09:00:00Z")
  const raised = tracker.update("error", undefined, at)
  assert.equal(raised.length, 1)
  assert.equal(raised[0]?.action, "Raised")
  assert.equal(raised[0]?.level, "Error")
  assert.equal(raised[0]?.mId, "UM3")
  assert.match(raised[0]?.id ?? "", /^[0-9a-f]{24}$/)
  assert.deepEqual(tracker.update("error", undefined, at), [])
  const reset = tracker.update("idle", undefined, at)
  assert.equal(reset[0]?.action, "Reset")
  assert.equal(reset[0]?.correlationId, raised[0]?.correlationId)
})

test("the event log sends only entries that are new since the start", () => {
  const tracker = new NotificationTracker("UM3")
  const now = new Date("2026-11-17T10:00:00Z")
  assert.deepEqual(tracker.fromLog([{ time: "2026-11-17T08:00:00", type_id: 1, message: "old" }], now), [])
  const fresh = tracker.fromLog([{ time: "2026-11-17T09:59:00", type_id: 2, message: "Print started" }, { time: "2026-11-17T08:00:00", type_id: 1, message: "old" }], now)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0]?.title, "Print started")
  assert.equal(fresh[0]?.timestamp, "2026-11-17T09:59:00.000Z")
})

test("material answered as a JSON string by firmware 5", () => {
  const xml = '<fdmmaterial><metadata><name><brand>Ultimaker</brand><material>PLA</material><color>Yellow</color></name><color_code>#f9a800</color_code></metadata></fdmmaterial>'
  assert.deepEqual(parseMaterial(xml), { brand: "Ultimaker", material: "PLA", color: "Yellow", colorCode: "#f9a800" })
})

test("helpers", () => {
  assert.equal(objectId(new Date(0)).slice(0, 8), "00000000")
  const now = new Date("2026-11-17T10:00:00Z")
  assert.equal(parseLogTime("2099-01-01T00:00:00", now), now)
  assert.equal(parseLogTime("garbage", now), now)
  assert.deepEqual(parseMaterial("<fdmmaterial><metadata><name><brand>Ultimaker</brand><material>PLA</material><color>Black</color></name></metadata></fdmmaterial>"), { brand: "Ultimaker", material: "PLA", color: "Black", colorCode: undefined })
})
