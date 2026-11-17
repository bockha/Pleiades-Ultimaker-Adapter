// Which value of the printer goes to which topic, in which SI unit. Converted once, here.
// Paths below machines/{SerialNumber}/: umati/... are named by the data model and the MQTT binding,
// vendor/... are specific to Ultimaker. Indices count from 1, like Channel/1 of the binding.

import type { Material, PrintJob, Printer, System } from "./ultimaker.ts"

export type Unit =
  | "one"
  | "second"
  | "metre"
  | "metrePerSecond"
  | "metrePerSecondSquared"
  | "radian"
  | "degreeCelsius"

export type Value =
  | { path: string; value: number; unit: Unit }
  | { path: string; value: string }
  | { path: string; value: boolean }

export type Snapshot = {
  status: string
  printer: Printer
  job: PrintJob | null
  system: System | null
  materials: ReadonlyMap<string, Material>
}

/** Job states in which the printer works on a part. */
const ACTIVE_JOB = new Set(["pre_print", "printing", "resuming", "post_print"])
/** Job states in which a started print stands still. */
const INTERRUPTED_JOB = new Set(["pausing", "paused", "wait_user_action"])

/** umati MachineryItemState: NotAvailable, OutOfService, NotExecuting, Executing. */
export function machineryItemState(status: string, jobState: string | undefined): string {
  switch (status) {
    case "booting":
      return "NotAvailable"
    case "error":
    case "maintenance":
      return "OutOfService"
    case "printing":
      return jobState !== undefined && ACTIVE_JOB.has(jobState) ? "Executing" : "NotExecuting"
    case "idle":
      return "NotExecuting"
    default:
      return "NotAvailable"
  }
}

/** umati MachineryOperationMode: None, Maintenance, Setup, Processing. */
export function machineryOperationMode(status: string, jobState: string | undefined): string {
  if (status === "maintenance") return "Maintenance"
  if (jobState === "wait_cleanup") return "Setup" // the print waits to be taken off the build plate
  if (jobState !== undefined && (ACTIVE_JOB.has(jobState) || INTERRUPTED_JOB.has(jobState))) return "Processing"
  return "None"
}

/** umati ChannelState: Active, Interrupted, Reset. */
export function channelState(jobState: string | undefined): string {
  if (jobState !== undefined && ACTIVE_JOB.has(jobState)) return "Active"
  if (jobState !== undefined && INTERRUPTED_JOB.has(jobState)) return "Interrupted"
  return "Reset"
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const mm = (value: number) => value / 1000
/** A fraction 0..1. Some firmware reports a percentage 0..100 instead. */
const ratio = (value: number) => (value > 1 ? value / 100 : value)

export function valuesOf(snapshot: Snapshot): Array<Value> {
  const out: Array<Value> = []
  const number = (path: string, value: unknown, unit: Unit, convert: (v: number) => number = (v) => v) => {
    // 12 significant digits drop the noise of the conversion (0.0972 instead of 0.09720000000000001).
    if (isNumber(value)) out.push({ path, value: Number(convert(value).toPrecision(12)), unit })
  }
  const text = (path: string, value: unknown) => {
    if (typeof value === "string") out.push({ path, value })
  }
  const flag = (path: string, value: unknown) => {
    if (typeof value === "boolean") out.push({ path, value })
  }

  const { status, printer, job, system } = snapshot
  const jobState = job?.state

  // Named by the data model and the binding.
  text("umati/State/MachineryItemState", machineryItemState(status, jobState))
  text("umati/State/MachineryOperationMode", machineryOperationMode(status, jobState))
  text("umati/Channel/1/ChannelState", channelState(jobState))
  text("umati/Production/ActiveProgram", job?.name ?? "")

  // The printer as a whole.
  text("vendor/Printer/Status", status)

  // Build plate.
  number("vendor/Bed/Temperature", printer.bed?.temperature?.current, "degreeCelsius")
  number("vendor/Bed/TargetTemperature", printer.bed?.temperature?.target, "degreeCelsius")
  flag("vendor/Bed/PreHeatActive", printer.bed?.pre_heat?.active)
  text("vendor/Bed/Type", printer.bed?.type)

  // Print head and its extruders (print cores).
  ;(printer.heads ?? []).forEach((head, h) => {
    const at = `vendor/Head/${h + 1}`
    number(`${at}/Position/X`, head.position?.x, "metre", mm)
    number(`${at}/Position/Y`, head.position?.y, "metre", mm)
    number(`${at}/Position/Z`, head.position?.z, "metre", mm)
    number(`${at}/MaxSpeed/X`, head.max_speed?.x, "metrePerSecond", mm)
    number(`${at}/MaxSpeed/Y`, head.max_speed?.y, "metrePerSecond", mm)
    number(`${at}/MaxSpeed/Z`, head.max_speed?.z, "metrePerSecond", mm)
    number(`${at}/Acceleration`, head.acceleration, "metrePerSecondSquared", mm)
    number(`${at}/Fan`, head.fan, "one", ratio)

    ;(head.extruders ?? []).forEach((extruder, e) => {
      const ex = `${at}/Extruder/${e + 1}`
      const hotend = extruder.hotend
      number(`${ex}/Hotend/Temperature`, hotend?.temperature?.current, "degreeCelsius")
      number(`${ex}/Hotend/TargetTemperature`, hotend?.temperature?.target, "degreeCelsius")
      text(`${ex}/Hotend/Id`, hotend?.id)
      text(`${ex}/Hotend/Serial`, hotend?.serial)
      number(`${ex}/Hotend/MaterialExtruded`, hotend?.statistics?.material_extruded, "metre", mm)
      number(`${ex}/Hotend/MaxTemperatureExposed`, hotend?.statistics?.max_temperature_exposed, "degreeCelsius")
      number(`${ex}/Hotend/TimeSpentHot`, hotend?.statistics?.time_spent_hot, "second")
      text(`${ex}/Hotend/Offset/State`, hotend?.offset?.state)
      number(`${ex}/Hotend/Offset/X`, hotend?.offset?.x, "metre", mm)
      number(`${ex}/Hotend/Offset/Y`, hotend?.offset?.y, "metre", mm)
      number(`${ex}/Hotend/Offset/Z`, hotend?.offset?.z, "metre", mm)
      number(`${ex}/Feeder/MaxSpeed`, extruder.feeder?.max_speed, "metrePerSecond", mm)
      number(`${ex}/Feeder/Acceleration`, extruder.feeder?.acceleration, "metrePerSecondSquared", mm)

      const material = extruder.active_material
      const guid = material?.GUID ?? material?.guid
      text(`${ex}/Material/Guid`, guid ?? "")
      const remaining = material?.length_remaining
      if (isNumber(remaining) && remaining >= 0) number(`${ex}/Material/LengthRemaining`, remaining, "metre", mm)
      const known = guid ? snapshot.materials.get(guid) : undefined
      if (known) {
        text(`${ex}/Material/Brand`, known.brand)
        text(`${ex}/Material/Type`, known.material)
        text(`${ex}/Material/Color`, known.color)
        text(`${ex}/Material/ColorCode`, known.colorCode)
      }
    })
  })

  // Network: only whether a link is up, no network names.
  flag("vendor/Network/Wifi/Connected", printer.network?.wifi?.connected)
  flag("vendor/Network/Ethernet/Connected", printer.network?.ethernet?.connected)

  // Case light.
  number("vendor/Led/Hue", printer.led?.hue, "radian", (deg) => (deg * Math.PI) / 180)
  number("vendor/Led/Saturation", printer.led?.saturation, "one", ratio)
  number("vendor/Led/Brightness", printer.led?.brightness, "one", ratio)

  // Print job. Without a job only its state is sent, as "none".
  text("vendor/PrintJob/State", jobState ?? "none")
  if (job) {
    number("vendor/PrintJob/Progress", job.progress, "one")
    number("vendor/PrintJob/TimeElapsed", job.time_elapsed, "second")
    number("vendor/PrintJob/TimeTotal", job.time_total, "second")
    if (isNumber(job.time_total) && isNumber(job.time_elapsed)) {
      number("vendor/PrintJob/TimeRemaining", Math.max(0, job.time_total - job.time_elapsed), "second")
    }
    text("vendor/PrintJob/Uuid", job.uuid)
    text("vendor/PrintJob/Result", job.result)
    text("vendor/PrintJob/Source", job.source)
    text("vendor/PrintJob/SourceUser", job.source_user)
    text("vendor/PrintJob/SourceApplication", job.source_application)
    text("vendor/PrintJob/DatetimeStarted", job.datetime_started)
    text("vendor/PrintJob/DatetimeFinished", job.datetime_finished)
  }

  // System, read less often.
  if (system) {
    text("vendor/System/Name", system.name)
    text("vendor/System/Hostname", system.hostname)
    text("vendor/System/Firmware", system.firmware)
    text("vendor/System/Platform", system.platform)
    text("vendor/System/Type", system.type)
    text("vendor/System/Variant", system.variant)
    text("vendor/System/Guid", system.guid)
    text("vendor/System/Country", system.country)
    text("vendor/System/Language", system.language)
    number("vendor/System/Uptime", system.uptime, "second")
    const { used, total } = system.memory ?? {}
    if (isNumber(used) && isNumber(total) && total > 0) number("vendor/System/MemoryUsage", used / total, "one")
  }

  return out
}
