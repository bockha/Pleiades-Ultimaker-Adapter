// The value envelope of the MQTT binding and the MQTT 5 client that sends it.

import mqtt from "mqtt"
import type { MqttClient } from "mqtt"

import type { Value } from "./mapping.ts"
import type { NotificationEvent } from "./notifications.ts"

export type Envelope = { timestamp: string; value: number | string | boolean; unit?: string }

export function envelope(value: Value, at: Date): Envelope {
  return "unit" in value
    ? { timestamp: at.toISOString(), value: value.value, unit: value.unit }
    : { timestamp: at.toISOString(), value: value.value }
}

/** The MQTT 5 content type that names the kind of a value. */
export function contentTypeOf(value: Value["value"]): string {
  if (typeof value === "number") return "baseunitvaluedto"
  if (typeof value === "boolean") return "booleanvaluedto"
  return "stringvaluedto"
}

/** Remembers what was sent, so that an unchanged value is sent again only after `republishMs`. */
export class ChangeFilter {
  private readonly last = new Map<string, { value: Value["value"]; sentAt: number }>()
  private readonly republishMs: number

  constructor(republishMs: number) {
    this.republishMs = republishMs
  }

  due(path: string, value: Value["value"], now: number): boolean {
    const last = this.last.get(path)
    return last === undefined || last.value !== value || now - last.sentAt >= this.republishMs
  }

  sent(path: string, value: Value["value"], now: number) {
    this.last.set(path, { value, sentAt: now })
  }

  /** Forget everything, so that every value is sent at the next chance. */
  clear() {
    this.last.clear()
  }
}

export class Publisher {
  readonly client: MqttClient
  private readonly base: string

  constructor(url: string, options: { clientId: string; username?: string; password?: string; serialNumber: string }) {
    this.base = `machines/${options.serialNumber}`
    this.client = mqtt.connect(url, {
      protocolVersion: 5, // notifications need the content type, an MQTT 5 property
      clientId: options.clientId,
      username: options.username,
      password: options.password,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
    })
  }

  get connected(): boolean {
    return this.client.connected
  }

  async value(value: Value, at: Date): Promise<void> {
    await this.client.publishAsync(`${this.base}/${value.path}`, JSON.stringify(envelope(value, at)), {
      qos: 1,
      properties: { contentType: contentTypeOf(value.value) },
    })
  }

  async notification(event: NotificationEvent): Promise<void> {
    await this.client.publishAsync(`${this.base}/events/notifications`, JSON.stringify(event), {
      qos: 1,
      properties: { contentType: "notificationeventdtov1" },
    })
  }

  async close(): Promise<void> {
    await this.client.endAsync()
  }
}
