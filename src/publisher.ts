// Puts what the adapter knows on the broker as the binding says, after MachinePublisher of the
// Playground:
// - At the first connect: Initializing, the manifest, the identification, the elements the printer
//   lacks as null, every value known, then Running or CommunicationFault once the printer was asked.
// - At every later connect: the same again, without a second Initializing.
// - Nothing else goes out on a connection before that sequence, not even the heartbeat.
// - While the printer answers a value goes out when it changes; one it no longer reports goes out once
//   as null. When it stops answering: CommunicationFault, the values stand, only the heartbeat goes on.
//   When it answers again: every value anew, then Running.
// - Events wait in a bounded outbox and go out after the connect sequence, in the order they came up.
// Every message is QoS 1; values and the manifest retained, events not.

import {
  CONNECTION_STATE, CONTENT_TYPE, EVENT_CONTENT_TYPE, HEARTBEAT, LAST_WILL_STATE,
  envelope, manifestTopic, topic, unavailable,
} from "./binding.ts"
import type { AdapterState, Identity, Json, MachineValue } from "./binding.ts"

export type PublishOptions = { qos: 1; retain: boolean; properties: { contentType: string } }

/** The part of an MQTT client the publisher uses; an MqttClient of mqtt.js fits. */
export interface Transport {
  readonly connected: boolean
  publish(topic: string, payload: string, options: PublishOptions, callback?: (error?: Error) => void): unknown
}

export const DEFAULT_OUTBOX_CAPACITY = 10_000

/** The last will: Connection/State CommunicationFault, retained, QoS 1, with the time it is set. */
export function lastWill(identity: Identity, at: Date) {
  return {
    topic: topic(identity.machineId, CONNECTION_STATE),
    payload: Buffer.from(JSON.stringify(envelope({ path: CONNECTION_STATE, value: LAST_WILL_STATE, timestamp: at }))),
    qos: 1 as const,
    retain: true,
    properties: { contentType: CONTENT_TYPE },
  }
}

/** What a value says, without its time: a value that says the same again does not go out. */
function signature(value: MachineValue): string {
  const { timestamp: _, ...rest } = envelope(value)
  return JSON.stringify(rest)
}

export class MachinePublisher {
  private readonly transport: Transport
  private readonly identity: Identity
  private readonly start: Date
  private readonly log: (message: string) => void
  private readonly outboxCapacity: number
  private manifest: { [key: string]: Json }
  private current = new Map<string, MachineValue>()
  private readonly sent = new Map<string, string>()
  private reachable: boolean | null = null
  private saidInitializing = false
  private synced = false
  private lastStateAt = 0
  private heartbeats = 0
  private readonly outbox: Array<{ topic: string; payload: string }> = []

  constructor(transport: Transport, identity: Identity, manifest: { [key: string]: Json }, options: { start?: Date; log?: (message: string) => void; outboxCapacity?: number } = {}) {
    this.transport = transport
    this.identity = identity
    this.manifest = manifest
    this.start = options.start ?? new Date()
    this.log = options.log ?? (() => undefined)
    this.outboxCapacity = options.outboxCapacity ?? DEFAULT_OUTBOX_CAPACITY
  }

  /** Whether the device was reached: true, false, or null before it was asked. */
  get reached(): boolean | null {
    return this.reachable
  }

  get pendingEvents(): number {
    return this.outbox.length
  }

  /** After a connect: the connect sequence, then the events that waited. */
  connected(now: Date) {
    this.synced = false
    this.sync(now)
  }

  /** The connection broke off: until the next connect sequence nothing goes out. */
  disconnected() {
    this.synced = false
  }

  /**
   * The printer answered with `values`, the whole of what it says now. A value that changed goes out;
   * one it said before and no longer says goes out once as null. When it had not answered before,
   * every value goes out and then Running.
   */
  answered(values: ReadonlyArray<MachineValue>, now: Date) {
    const next = new Map<string, MachineValue>()
    for (const v of values) next.set(v.path, v)
    for (const [path, old] of this.current) {
      if (!next.has(path)) next.set(path, old.value === null ? old : { path, value: null, timestamp: now })
    }
    const wasReached = this.reachable === true
    this.current = next
    this.reachable = true
    if (!this.ready()) return
    if (!wasReached) {
      this.sendAll()
      this.sendState("Running", now)
      return
    }
    for (const v of this.current.values()) {
      const s = signature(v)
      if (this.sent.get(v.path) !== s) {
        this.sendValue(v)
        this.sent.set(v.path, s)
      }
    }
  }

  /** The printer does not answer: CommunicationFault, once. The values stand with their time. */
  lost(now: Date) {
    const changed = this.reachable !== false
    this.reachable = false
    if (changed && this.ready()) this.sendState("CommunicationFault", now)
  }

  /** The sign of life of the adapter, a count from 1, once the connect sequence has gone out. */
  heartbeat(now: Date) {
    if (!this.ready()) return
    this.heartbeats += 1
    this.sendValue({ path: HEARTBEAT, value: this.heartbeats, timestamp: now })
  }

  /** An event, not retained: at once after the connect sequence, else it waits in the outbox. */
  event(eventTopic: string, cloudEvent: { [key: string]: Json }) {
    this.outbox.push({ topic: eventTopic, payload: JSON.stringify(cloudEvent) })
    if (this.outbox.length > this.outboxCapacity) {
      const dropped = this.outbox.shift()
      this.log(`outbox holds ${this.outboxCapacity} events; the oldest, for ${dropped?.topic}, is dropped`)
    }
    if (this.ready()) this.drain()
  }

  /** A new manifest, for example when the printer reports more extruders. Goes out at once if it differs. */
  updateManifest(manifest: { [key: string]: Json }) {
    if (JSON.stringify(manifest) === JSON.stringify(this.manifest)) return
    this.manifest = manifest
    if (this.ready()) this.publish(manifestTopic(this.identity.machineId), JSON.stringify(manifest), true)
  }

  /** A clean stop: Shutdown, the last message; resolves once the broker has it, or after `waitMs`. */
  shutdown(now: Date, waitMs = 5000): Promise<void> {
    if (!this.transport.connected) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs)
      this.sendState("Shutdown", now, () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private ready(): boolean {
    return this.transport.connected && this.synced
  }

  private sync(now: Date) {
    if (!this.transport.connected) return
    if (!this.saidInitializing) {
      this.sendState("Initializing", now)
      this.saidInitializing = true
    }
    this.publish(manifestTopic(this.identity.machineId), JSON.stringify(this.manifest), true)
    for (const v of this.identity.values(this.start)) this.sendValue(v)
    for (const path of unavailable(this.manifest)) this.sendValue({ path, value: null, timestamp: this.start })
    this.sendAll()
    if (this.reachable !== null) this.sendState(this.reachable ? "Running" : "CommunicationFault", now)
    this.synced = true
    this.log(`published the manifest and ${this.current.size} values of ${this.identity.machineId} after a connect`)
    this.drain()
  }

  private sendAll() {
    for (const v of this.current.values()) {
      this.sendValue(v)
      this.sent.set(v.path, signature(v))
    }
  }

  /**
   * Connection/State, a millisecond after the state before it at the latest: with the same instant a
   * store that reads the newest value could not tell which of two states came last.
   */
  private sendState(state: AdapterState, now: Date, callback?: () => void) {
    const at = Math.max(now.getTime(), this.lastStateAt + 1)
    this.lastStateAt = at
    this.sendValue({ path: CONNECTION_STATE, value: state, timestamp: new Date(at) }, callback)
  }

  private sendValue(value: MachineValue, callback?: () => void) {
    this.publish(topic(this.identity.machineId, value.path), JSON.stringify(envelope(value)), true, callback)
  }

  private drain() {
    while (this.outbox.length > 0 && this.transport.connected) {
      const next = this.outbox.shift()!
      this.transport.publish(next.topic, next.payload, { qos: 1, retain: false, properties: { contentType: EVENT_CONTENT_TYPE } }, (error) => {
        if (error) this.log(`event for ${next.topic} not sent: ${error.message}`)
      })
    }
  }

  private publish(to: string, payload: string, retain: boolean, callback?: () => void) {
    this.transport.publish(to, payload, { qos: 1, retain, properties: { contentType: CONTENT_TYPE } }, (error) => {
      if (error) this.log(`${to} not sent: ${error.message}`)
      callback?.()
    })
  }
}
