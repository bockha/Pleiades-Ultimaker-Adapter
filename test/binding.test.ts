import assert from "node:assert/strict"
import { test } from "node:test"

import { EventSequence, Identity, envelope, extensionPrefix, machineId, manifest, topic, unavailable } from "../src/binding.ts"
import { CONTENT_TYPE, EVENT_CONTENT_TYPE } from "../src/binding.ts"
import type { Json } from "../src/binding.ts"
import { MachinePublisher, lastWill } from "../src/publisher.ts"
import type { PublishOptions, Transport } from "../src/publisher.ts"

test("machine ids as the table of the binding gives them", () => {
  assert.equal(machineId("https://www.alcyone-machines.example", "AX-400", "P-04"), "alcyone-machines_AX-400_P-04")
  assert.equal(machineId("https://machines.example.co.uk", "AX-400", "P-04"), "machines-example-co_AX-400_P-04")
  assert.equal(machineId("https://müller-maschinen.de", "Schleifer 5/2", "SN 0815#a"), "mueller-maschinen_Schleifer-5-2_SN-0815-a")
  assert.equal(machineId("https://ultimaker.com", "UM3", "UM3-01"), "ultimaker_UM3_UM3-01")
  assert.equal(machineId("https://ultimaker.com", "UM3", ""), "ultimaker_UM3_unknown")
  assert.equal(extensionPrefix("ultimaker.com"), "x-ultimaker-com")
})

test("identity: product instance URI and the identification", () => {
  const identity = new Identity({ manufacturer: "Ultimaker", manufacturerUri: "https://ultimaker.com", model: "UM3", serialNumber: "Dave" })
  assert.equal(identity.machineId, "ultimaker_UM3_Dave")
  assert.equal(identity.productInstanceUri, "https://ultimaker.com/UM3/Dave")
  assert.equal(identity.signal("Ultimaker.Bed.Temperature"), "x-ultimaker-com.Ultimaker.Bed.Temperature")
  assert.deepEqual(identity.values(new Date(0)).map((v) => v.path), [
    "Identification.Manufacturer", "Identification.SerialNumber", "Identification.ProductInstanceUri",
    "Identification.ManufacturerUri", "Identification.Model",
  ])
})

test("topics: the model below umati/, a signal of the manufacturer below oem/", () => {
  assert.equal(topic("m", "State.Status"), "machines/m/umati/State/Status")
  assert.equal(topic("m", "x-ultimaker-com.Ultimaker.Extruder.0.Temperature"), "machines/m/oem/Ultimaker/Extruder/0/Temperature")
  assert.throws(() => topic("m", "x-.Foo"))
})

test("envelope: a unit only with a plain value", () => {
  const t = new Date("2026-11-18T10:00:00.123Z")
  assert.deepEqual(envelope({ path: "p", value: 21.5, unit: "degreeCelsius", timestamp: t }), { timestamp: "2026-11-18T10:00:00.123Z", value: 21.5, unit: "degreeCelsius" })
  assert.deepEqual(envelope({ path: "p", value: { A: "x" }, unit: "one", timestamp: t }), { timestamp: "2026-11-18T10:00:00.123Z", value: { A: "x" } })
  assert.deepEqual(envelope({ path: "p", value: null, timestamp: t }), { timestamp: "2026-11-18T10:00:00.123Z", value: null })
})

const identity = new Identity({ manufacturer: "Ultimaker", manufacturerUri: "https://ultimaker.com", model: "UM3", serialNumber: "Dave" })
const theManifest = manifest(identity, 10, [
  { path: "State.Status" },
  { path: "Notification.ActiveAlerts" },
  { path: "x-ultimaker-com.Ultimaker.Bed.Temperature", signal: { type: "number", unit: { code: "CEL", name: "degreeCelsius" }, description: "Bed" } },
], ["Notification.AlertRaised"])

test("manifest: Core whole, what the printer lacks unavailable, then the signals and events", () => {
  assert.equal(theManifest.modelVersion, "0.17.1")
  assert.equal(theManifest.machineId, "ultimaker_UM3_Dave")
  assert.deepEqual(theManifest.machine, { ProductInstanceUri: "https://ultimaker.com/UM3/Dave" })
  assert.deepEqual(theManifest.profiles, ["Core"])
  assert.equal(theManifest.heartbeatInterval, 10)
  assert.deepEqual(unavailable(theManifest), [
    "Identification.ProductCode", "Identification.YearOfConstruction", "State.FeedOverride", "OperationCounters.PowerOnDuration",
  ])
  const elements = theManifest.elements as Array<{ [key: string]: Json }>
  assert.equal(elements.length, 14)
  assert.deepEqual(elements[13], { path: "x-ultimaker-com.Ultimaker.Bed.Temperature", timestampSource: "adapter", type: "number", unit: { code: "CEL", name: "degreeCelsius" }, description: "Bed" })
  assert.deepEqual(theManifest.events, [{ path: "Notification.AlertRaised" }])
})

test("CloudEvents: sequence counts from 1 below the start of the adapter", () => {
  const events = new EventSequence("https://ultimaker.com/UM3/Dave", new Date("2026-11-18T06:58:12.345Z"))
  const first = events.next("Notification.AlertRaised", new Date("2026-11-18T07:00:00Z"), { Id: "a" })
  const second = events.next("Notification.AlertCleared", new Date("2026-11-18T07:00:05Z"), { Id: "a" })
  assert.equal(first.specversion, "1.0")
  assert.equal(first.source, "https://ultimaker.com/UM3/Dave")
  assert.equal(first.sequence, "20261118T065812Z.000000000001")
  assert.equal(second.sequence, "20261118T065812Z.000000000002")
  assert.equal(first.dataschema, "urn:umati2:datamodel:0.17.1:event.schema.json")
  assert.match(String(first.id), /^[0-9a-f-]{36}$/)
  assert.notEqual(first.id, second.id)
})

class FakeTransport implements Transport {
  connected = false
  messages: Array<{ topic: string; payload: Json; options: PublishOptions }> = []
  publish(topic: string, payload: string, options: PublishOptions, callback?: (error?: Error) => void) {
    this.messages.push({ topic, payload: JSON.parse(payload) as Json, options })
    callback?.()
  }
  take() {
    const out = this.messages
    this.messages = []
    return out
  }
}

const bed = (value: number, timestamp: Date) => ({ path: "x-ultimaker-com.Ultimaker.Bed.Temperature", value, unit: "degreeCelsius", timestamp })
const state = (m: { payload: Json }) => (m.payload as { value: Json }).value

test("publisher: the connect sequence, then only changes, null for a value that is gone", () => {
  const transport = new FakeTransport()
  const publisher = new MachinePublisher(transport, identity, theManifest, { start: new Date("2026-11-18T10:00:00Z") })
  const t1 = new Date("2026-11-18T10:00:01Z")

  // Before the connect nothing goes out, not even the heartbeat.
  publisher.answered([bed(20, t1)], t1)
  publisher.heartbeat(t1)
  assert.deepEqual(transport.take(), [])

  transport.connected = true
  publisher.connected(t1)
  const sequence = transport.take()
  const topics = sequence.map((m) => m.topic.replace("machines/ultimaker_UM3_Dave/", ""))
  assert.deepEqual(topics, [
    "umati/Connection/State", "umati/Manifest",
    "umati/Identification/Manufacturer", "umati/Identification/SerialNumber", "umati/Identification/ProductInstanceUri",
    "umati/Identification/ManufacturerUri", "umati/Identification/Model",
    "umati/Identification/ProductCode", "umati/Identification/YearOfConstruction", "umati/State/FeedOverride",
    "umati/OperationCounters/PowerOnDuration",
    "oem/Ultimaker/Bed/Temperature",
    "umati/Connection/State",
  ])
  assert.equal(state(sequence[0]!), "Initializing")
  assert.equal(state(sequence.at(-1)!), "Running")
  assert.equal(state(sequence[7]!), null)
  for (const m of sequence) {
    assert.equal(m.options.qos, 1)
    assert.equal(m.options.retain, true)
    assert.equal(m.options.properties.contentType, CONTENT_TYPE)
  }
  const initializing = (sequence[0]!.payload as { timestamp: string }).timestamp
  const running = (sequence.at(-1)!.payload as { timestamp: string }).timestamp
  assert.ok(running > initializing, "Running a millisecond after Initializing at least")

  // The same value again does not go out; a changed one does; one that is gone goes out as null once.
  const t2 = new Date("2026-11-18T10:00:06Z")
  publisher.answered([bed(20, t2)], t2)
  assert.deepEqual(transport.take(), [])
  publisher.answered([bed(21, t2)], t2)
  assert.deepEqual(transport.take().map(state), [21])
  publisher.answered([], t2)
  assert.deepEqual(transport.take().map(state), [null])
  publisher.answered([], t2)
  assert.deepEqual(transport.take(), [])

  publisher.heartbeat(t2)
  publisher.heartbeat(t2)
  const beats = transport.take()
  assert.deepEqual(beats.map(state), [1, 2])
  assert.equal(beats[0]!.topic, "machines/ultimaker_UM3_Dave/umati/Connection/Heartbeat")
  assert.equal((beats[0]!.payload as { unit?: string }).unit, undefined, "the heartbeat has no unit in the catalogue")
})

test("publisher: CommunicationFault once, then every value anew and Running", () => {
  const transport = new FakeTransport()
  transport.connected = true
  const publisher = new MachinePublisher(transport, identity, theManifest)
  const t = new Date("2026-11-18T10:00:01Z")
  publisher.connected(t)
  publisher.answered([bed(20, t)], t)
  transport.take()

  publisher.lost(t)
  publisher.lost(t)
  assert.deepEqual(transport.take().map(state), ["CommunicationFault"])
  publisher.answered([bed(20, t)], t)
  assert.deepEqual(transport.take().map(state), [20, "Running"])
})

test("publisher: events wait for the connect sequence, then go out in order, not retained", () => {
  const transport = new FakeTransport()
  const publisher = new MachinePublisher(transport, identity, theManifest, { outboxCapacity: 2 })
  publisher.event("machines/ultimaker_UM3_Dave/events/notifications", { n: 1 })
  publisher.event("machines/ultimaker_UM3_Dave/events/notifications", { n: 2 })
  publisher.event("machines/ultimaker_UM3_Dave/events/notifications", { n: 3 })
  assert.equal(publisher.pendingEvents, 2, "the oldest is dropped when the outbox is full")
  transport.connected = true
  publisher.connected(new Date())
  const events = transport.take().filter((m) => m.topic.endsWith("/events/notifications"))
  assert.deepEqual(events.map((m) => m.payload), [{ n: 2 }, { n: 3 }])
  assert.equal(events[0]!.options.retain, false)
  assert.equal(events[0]!.options.properties.contentType, EVENT_CONTENT_TYPE)
})

test("last will: CommunicationFault, retained", () => {
  const will = lastWill(identity, new Date("2026-11-18T10:00:00Z"))
  assert.equal(will.topic, "machines/ultimaker_UM3_Dave/umati/Connection/State")
  assert.equal(will.retain, true)
  assert.deepEqual(JSON.parse(will.payload.toString()), { timestamp: "2026-11-18T10:00:00.000Z", value: "CommunicationFault" })
})
