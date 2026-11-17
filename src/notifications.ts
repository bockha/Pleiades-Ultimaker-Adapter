// Alarms and messages of the printer as notification events of the Events API
// (NotificationEventDtoV1, content type notificationeventdtov1). A condition is raised when it
// begins and reset when it ends, both with the same correlation id.

import { randomBytes } from "node:crypto"

import type { HistoryEvent } from "./ultimaker.ts"

export type Level = "Information" | "Warning" | "Error"

export type NotificationEvent = {
  timestamp: string
  id: string
  mId: string
  level: Level
  action: "Raised" | "Reset"
  title: string
  localizedTitle: string
  notificationId: string
  correlationId: string
}

/** A MongoDB ObjectId in hex: the Events API stores the id as one. */
export function objectId(now = new Date()): string {
  const seconds = Math.floor(now.getTime() / 1000).toString(16).padStart(8, "0")
  return seconds + randomBytes(8).toString("hex")
}

type Condition = { notificationId: string; level: Level; title: string; holds: (status: string, jobState?: string) => boolean }

/** Conditions that last, derived from the state of the printer and its job. */
export const CONDITIONS: ReadonlyArray<Condition> = [
  {
    notificationId: "printer-error",
    level: "Error",
    title: "Printer reports an error",
    holds: (status) => status === "error",
  },
  {
    notificationId: "printer-maintenance",
    level: "Warning",
    title: "Printer is in maintenance",
    holds: (status) => status === "maintenance",
  },
  {
    notificationId: "job-wait-user-action",
    level: "Warning",
    title: "Print job waits for a user action",
    holds: (_, job) => job === "wait_user_action",
  },
  {
    notificationId: "job-paused",
    level: "Information",
    title: "Print job paused",
    holds: (_, job) => job === "pausing" || job === "paused",
  },
  {
    notificationId: "job-wait-cleanup",
    level: "Information",
    title: "Print finished, remove the print from the build plate",
    holds: (_, job) => job === "wait_cleanup",
  },
]

export class NotificationTracker {
  private readonly mId: string
  /** Correlation id of every condition that is raised now. */
  private readonly open = new Map<string, string>()
  private seenEvents: Set<string> | null = null

  constructor(mId: string) {
    this.mId = mId
  }

  private event(level: Level, action: "Raised" | "Reset", notificationId: string, title: string, correlationId: string, at: Date): NotificationEvent {
    return {
      timestamp: at.toISOString(),
      id: objectId(at),
      mId: this.mId,
      level,
      action,
      title,
      localizedTitle: title,
      notificationId,
      correlationId,
    }
  }

  /** The events for the conditions that began or ended since the last call. */
  update(status: string, jobState: string | undefined, at: Date): Array<NotificationEvent> {
    const out: Array<NotificationEvent> = []
    for (const c of CONDITIONS) {
      const holds = c.holds(status, jobState)
      const correlationId = this.open.get(c.notificationId)
      if (holds && correlationId === undefined) {
        const id = objectId(at)
        this.open.set(c.notificationId, id)
        out.push(this.event(c.level, "Raised", c.notificationId, c.title, id, at))
      } else if (!holds && correlationId !== undefined) {
        this.open.delete(c.notificationId)
        out.push(this.event(c.level, "Reset", c.notificationId, c.title, correlationId, at))
      }
    }
    return out
  }

  /** Resets every open condition, for example when the printer can no longer be reached. */
  resetAll(at: Date): Array<NotificationEvent> {
    return this.update("", undefined, at)
  }

  /**
   * New entries of the printer's event log, each a message of level Information that is raised
   * once. The entries present at the first call are history and are not sent.
   */
  fromLog(events: ReadonlyArray<HistoryEvent>, now: Date): Array<NotificationEvent> {
    const key = (e: HistoryEvent) => `${e.time ?? ""}|${e.type_id ?? ""}|${e.message ?? ""}`
    const first = this.seenEvents === null
    const seen = (this.seenEvents ??= new Set())
    const out: Array<NotificationEvent> = []
    for (const e of events) {
      if (typeof e?.message !== "string" || e.message === "") continue
      const k = key(e)
      if (seen.has(k)) continue
      seen.add(k)
      if (first) continue
      const at = parseLogTime(e.time, now)
      out.push(this.event("Information", "Raised", `log-${e.type_id ?? "unknown"}`, e.message, objectId(at), at))
    }
    // Keep the set small: only the keys of the entries the printer still returns.
    if (seen.size > 500) this.seenEvents = new Set(events.map(key))
    return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
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
