// Alarms and messages of the printer as the data model has them: conditions that last are alerts of
// Notification.ActiveAlerts with the events Notification.AlertRaised and Notification.AlertCleared;
// a message that does not stay is a Notification.NotificationEvent, an alert without Severity.
// The list goes out before the events that change it. Severity is the category of NAMUR NE 107; which
// condition gets which is an assumption of this adapter.

import { randomUUID } from "node:crypto"

import { timestampOf } from "./binding.ts"
import type { Json } from "./binding.ts"
import type { HistoryEvent } from "./ultimaker.ts"

export const ALERT_RAISED = "Notification.AlertRaised"
export const ALERT_CLEARED = "Notification.AlertCleared"
export const NOTIFICATION_EVENT = "Notification.NotificationEvent"
export const EVENTS: ReadonlyArray<string> = [ALERT_RAISED, ALERT_CLEARED, NOTIFICATION_EVENT]

export type Severity = "Failure" | "CheckFunction" | "OffSpec" | "MaintenanceRequired"
export type Alert = { [key: string]: Json } & { Id: string; ErrorCode: string; Message: string; Time: string; Severity?: Severity }
/** An event of the group Notification, before it becomes a CloudEvent. */
export type NotificationOut = { type: string; data: Alert; time: Date }

type Condition = { code: string; severity: Severity; message: string; holds: (status: string, jobState?: string) => boolean }

/** Conditions that last, derived from the state of the printer and its job. */
export const CONDITIONS: ReadonlyArray<Condition> = [
  { code: "printer-error", severity: "Failure", message: "Printer reports an error", holds: (status) => status === "error" },
  { code: "printer-maintenance", severity: "CheckFunction", message: "Printer is in maintenance", holds: (status) => status === "maintenance" },
  { code: "job-wait-user-action", severity: "CheckFunction", message: "Print job waits for a user action", holds: (_, job) => job === "wait_user_action" },
]

/** A message that comes once when the job enters a state. */
const MESSAGES: ReadonlyArray<{ code: string; message: string; jobState: string }> = [
  { code: "job-wait-cleanup", message: "Print finished, remove the print from the build plate", jobState: "wait_cleanup" },
]

export class AlertTracker {
  private readonly active = new Map<string, Alert>()
  private lastJobState: string | undefined
  private seenLog: Set<string> | null = null

  /** The whole list of Notification.ActiveAlerts, [] for none. */
  list(): Array<Alert> {
    return [...this.active.values()].map((a) => ({ ...a }))
  }

  /** The events for the conditions that began or ended, and the messages of a job state just reached. */
  update(status: string, jobState: string | undefined, at: Date): Array<NotificationOut> {
    const out: Array<NotificationOut> = []
    for (const c of CONDITIONS) {
      const holds = c.holds(status, jobState)
      const standing = this.active.get(c.code)
      if (holds && !standing) {
        const alert: Alert = { Id: randomUUID(), ErrorCode: c.code, Message: c.message, Severity: c.severity, Time: timestampOf(at) }
        this.active.set(c.code, alert)
        out.push({ type: ALERT_RAISED, data: { ...alert }, time: at })
      } else if (!holds && standing) {
        this.active.delete(c.code)
        out.push({ type: ALERT_CLEARED, data: { ...standing }, time: at })
      }
    }
    if (jobState !== this.lastJobState) {
      for (const m of MESSAGES) {
        if (m.jobState === jobState) out.push({ type: NOTIFICATION_EVENT, data: { Id: randomUUID(), ErrorCode: m.code, Message: m.message, Time: timestampOf(at) }, time: at })
      }
      this.lastJobState = jobState
    }
    return out
  }

  /**
   * New entries of the printer's event log, each a NotificationEvent. The entries present at the
   * first call are history and are not sent.
   */
  fromLog(events: ReadonlyArray<HistoryEvent>, now: Date): Array<NotificationOut> {
    const key = (e: HistoryEvent) => `${e.time ?? ""}|${e.type_id ?? ""}|${e.message ?? ""}`
    const first = this.seenLog === null
    const seen = (this.seenLog ??= new Set())
    const out: Array<NotificationOut> = []
    for (const e of events) {
      if (typeof e?.message !== "string" || e.message === "") continue
      const k = key(e)
      if (seen.has(k)) continue
      seen.add(k)
      if (first) continue
      const at = parseLogTime(e.time, now)
      out.push({ type: NOTIFICATION_EVENT, data: { Id: randomUUID(), ErrorCode: String(e.type_id ?? "unknown"), Message: e.message, Time: timestampOf(at) }, time: at })
    }
    // Keep the set small: only the keys of the entries the printer still returns.
    if (seen.size > 500) this.seenLog = new Set(events.map(key))
    return out.sort((a, b) => a.time.getTime() - b.time.getTime())
  }
}

/** The time of a log entry, never in the future. Falls back to now if it cannot be read. */
export function parseLogTime(time: string | undefined, now: Date): Date {
  if (!time) return now
  // The printer writes its time without a zone; it runs on UTC.
  const parsed = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(time) ? time : `${time.replace(" ", "T")}Z`)
  if (Number.isNaN(parsed.getTime()) || parsed > now) return now
  return parsed
}
