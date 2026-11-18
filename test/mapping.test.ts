import assert from "node:assert/strict"
import { test } from "node:test"

import { Identity } from "../src/binding.ts"
import type { MachineValue } from "../src/binding.ts"
import { DEFAULT_EXTRUDERS, machineryItemState, machineryOperationMode, signals, valuesOf } from "../src/mapping.ts"
import { ALERT_CLEARED, ALERT_RAISED, AlertTracker, NOTIFICATION_EVENT, parseLogTime } from "../src/notifications.ts"
import { parseMaterial } from "../src/ultimaker.ts"

const identity = new Identity({ manufacturer: "Ultimaker", manufacturerUri: "https://ultimaker.com", model: "UM3", serialNumber: "Dave" })
const byPath = (values: Array<MachineValue>) => new Map(values.map((v) => [v.path, v]))
const at = new Date("2026-11-18T10:00:00.000Z")

test("states of the printer map to the snapshot State.Status", () => {
  assert.equal(machineryItemState("printing", "printing"), "Executing")
  assert.equal(machineryItemState("printing", "paused"), "NotExecuting")
  assert.equal(machineryItemState("idle", undefined), "NotExecuting")
  assert.equal(machineryItemState("error", undefined), "OutOfService")
  assert.equal(machineryItemState("something-new", undefined), "OutOfService")
  assert.equal(machineryItemState("booting", undefined), "NotAvailable")
  assert.equal(machineryOperationMode("printing", "printing"), "Processing")
  assert.equal(machineryOperationMode("printing", "wait_cleanup"), "Setup")
  assert.equal(machineryOperationMode("maintenance", undefined), "Maintenance")
  assert.equal(machineryOperationMode("idle", undefined), "None")
})

test("values: the snapshot of the model, signals below x-ultimaker-com in the units of the catalogue", () => {
  const values = byPath(valuesOf({
    status: "printing",
    printer: {
      bed: { temperature: { current: 59.8, target: 60 }, type: "glass" },
      heads: [{ position: { x: 120, y: 97.2, z: 1.5 }, fan: 50,
        extruders: [
          { hotend: { id: "AA 0.4", temperature: { current: 210, target: 210 } }, active_material: { GUID: "g", length_remaining: 1000 } },
          { hotend: { id: "BB 0.4", temperature: { current: 25, target: 0 } }, active_material: { GUID: "", length_remaining: -1 } },
        ] }],
    },
    job: { name: "part.gcode", uuid: "u-1", state: "printing", progress: 0.25, time_elapsed: 100, time_total: 400, source_user: "someone" },
    system: { firmware: "5.3.0" },
    materials: new Map([["g", { brand: "Ultimaker", material: "PLA", color: "Black", colorCode: "#0e0e10" }]]),
  }, identity, at))

  assert.deepEqual(values.get("State.Status")?.value, { MachineryItemState: "Executing", MachineryOperationMode: "Processing" })
  assert.deepEqual(values.get("x-ultimaker-com.Ultimaker.Bed.Temperature"), { path: "x-ultimaker-com.Ultimaker.Bed.Temperature", value: 59.8, unit: "degreeCelsius", timestamp: at })
  assert.equal(values.get("x-ultimaker-com.Ultimaker.Position.Y")?.value, 0.0972)
  assert.equal(values.get("x-ultimaker-com.Ultimaker.Position.Y")?.unit, "metre")
  assert.equal(values.get("x-ultimaker-com.Ultimaker.FanFraction")?.value, 0.5)
  assert.equal(values.get("x-ultimaker-com.Ultimaker.Extruder.0.Temperature")?.value, 210)
  assert.equal(values.get("x-ultimaker-com.Ultimaker.Extruder.0.MaterialRemainingLength")?.value, 1)
  assert.equal(values.get("x-ultimaker-com.Ultimaker.Extruder.0.MaterialType")?.value, "PLA")
  assert.equal(values.get("x-ultimaker-com.Ultimaker.Extruder.0.MaterialColorCode")?.value, "#0e0e10")
  assert.equal(values.get("x-ultimaker-com.Ultimaker.Extruder.1.HotendId")?.value, "BB 0.4")
  // An empty print core: no material values, no negative length.
  assert.equal(values.has("x-ultimaker-com.Ultimaker.Extruder.1.MaterialRemainingLength"), false)
  assert.equal(values.has("x-ultimaker-com.Ultimaker.Extruder.1.MaterialType"), false)
  assert.equal(values.get("x-ultimaker-com.Ultimaker.Print.Progress")?.unit, "one")
  assert.equal(values.get("x-ultimaker-com.Ultimaker.Print.TimeRemaining")?.value, 300)
  assert.equal(values.get("x-ultimaker-com.Ultimaker.Print.Name")?.value, "part.gcode")
  assert.equal(values.get("x-ultimaker-com.Ultimaker.System.Firmware")?.value, "5.3.0")
  // The user who sent the job is not published.
  assert.equal([...values.values()].some((v) => v.value === "someone"), false)
  // Every value is named in the manifest.
  const named = new Set(signals(DEFAULT_EXTRUDERS).map(([p]) => identity.signal(p)))
  for (const path of values.keys()) if (path.startsWith("x-")) assert.ok(named.has(path), path)
})

test("without a job only its state goes out, as none", () => {
  const values = byPath(valuesOf({ status: "idle", printer: {}, job: null, system: null, materials: new Map() }, identity, at))
  assert.equal(values.get("x-ultimaker-com.Ultimaker.Print.State")?.value, "none")
  assert.equal(values.has("x-ultimaker-com.Ultimaker.Print.Progress"), false)
  assert.deepEqual(values.get("State.Status")?.value, { MachineryItemState: "NotExecuting", MachineryOperationMode: "None" })
})

test("a condition is an alert while it holds: AlertRaised, AlertCleared and the list", () => {
  const tracker = new AlertTracker()
  assert.deepEqual(tracker.update("idle", undefined, at), [])
  assert.deepEqual(tracker.list(), [])

  const raised = tracker.update("error", undefined, at)
  assert.equal(raised.length, 1)
  assert.equal(raised[0]?.type, ALERT_RAISED)
  assert.equal(raised[0]?.data.ErrorCode, "printer-error")
  assert.equal(raised[0]?.data.Severity, "Failure")
  assert.equal(raised[0]?.data.Time, "2026-11-18T10:00:00.000Z")
  assert.equal(tracker.list().length, 1)
  assert.deepEqual(tracker.update("error", undefined, at), [], "raised once")

  const later = new Date(at.getTime() + 5000)
  const cleared = tracker.update("idle", undefined, later)
  assert.equal(cleared[0]?.type, ALERT_CLEARED)
  assert.equal(cleared[0]?.data.Id, raised[0]?.data.Id, "the same alert")
  assert.deepEqual(tracker.list(), [])
})

test("the end of a print is a NotificationEvent, once", () => {
  const tracker = new AlertTracker()
  const events = tracker.update("printing", "wait_cleanup", at)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, NOTIFICATION_EVENT)
  assert.equal(events[0]?.data.Severity, undefined)
  assert.deepEqual(tracker.update("printing", "wait_cleanup", at), [])
  assert.deepEqual(tracker.list(), [], "a message does not stay")
})

test("new entries of the printer's event log are NotificationEvents, history is not", () => {
  const tracker = new AlertTracker()
  const now = new Date("2026-11-17T10:00:00Z")
  assert.deepEqual(tracker.fromLog([{ time: "2026-11-17T08:00:00", type_id: 1, message: "old" }], now), [])
  const fresh = tracker.fromLog([{ time: "2026-11-17T09:59:00", type_id: 2, message: "Print started" }, { time: "2026-11-17T08:00:00", type_id: 1, message: "old" }], now)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0]?.type, NOTIFICATION_EVENT)
  assert.equal(fresh[0]?.data.Message, "Print started")
  assert.equal(fresh[0]?.data.ErrorCode, "2")
  assert.equal(fresh[0]?.data.Time, "2026-11-17T09:59:00.000Z")
})

test("material answered as a JSON string by firmware 5", () => {
  const xml = '<fdmmaterial><metadata><name><brand>Ultimaker</brand><material>PLA</material><color>Yellow</color></name><color_code>#f9a800</color_code></metadata></fdmmaterial>'
  assert.deepEqual(parseMaterial(xml), { brand: "Ultimaker", material: "PLA", color: "Yellow", colorCode: "#f9a800" })
})

test("log times are never in the future", () => {
  const now = new Date("2026-11-17T10:00:00Z")
  assert.equal(parseLogTime("2099-01-01T00:00:00", now), now)
  assert.equal(parseLogTime("garbage", now), now)
})
