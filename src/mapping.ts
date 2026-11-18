// What the printer says, as values of the binding: the state as the snapshot State.Status of the
// model, everything else as signals of the manufacturer below the prefix x-ultimaker-com, which the
// binding maps to oem/. The paths of the signals that the Ultimaker telemetry of the Playground also
// publishes are the same as there (contracts/ultimaker/telemetry.md), so a card reads both alike;
// extruder indices start at zero, as the printer counts them. Units are converted once, here.

import { STATUS, UNITS } from "./binding.ts"
import type { Identity, MachineValue, Signal, Unit } from "./binding.ts"
import type { Material, PrintJob, Printer, System } from "./ultimaker.ts"

/** The first segment of every signal below the prefix of the manufacturer. */
export const ROOT = "Ultimaker"
/** How many extruders the manifest names before the printer reported any: an Ultimaker 3 has two. */
export const DEFAULT_EXTRUDERS = 2

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

/**
 * MachineryItemState. The printer answers, so a state the model has no word for is OutOfService,
 * "available but unable to perform any activity", as in the Ultimaker telemetry of the Playground.
 */
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
      return "OutOfService"
  }
}

/** MachineryOperationMode: None, Maintenance, Setup, Processing. */
export function machineryOperationMode(status: string, jobState: string | undefined): string {
  if (status === "maintenance") return "Maintenance"
  if (jobState === "wait_cleanup") return "Setup" // the print waits to be taken off the build plate
  if (jobState !== undefined && (ACTIVE_JOB.has(jobState) || INTERRUPTED_JOB.has(jobState))) return "Processing"
  return "None"
}

const text = (description: string): Signal => ({ type: "string", description })
const number = (unit: Unit, description: string): Signal => ({ type: "number", unit, description })

/** Every signal below the prefix that does not belong to one extruder. */
const SIGNALS: ReadonlyArray<[string, Signal]> = [
  ["PrinterStatus", text("Status of the printer as its API says it: idle, printing, error, maintenance or booting")],
  ["Bed.Temperature", number(UNITS.degreeCelsius, "Temperature of the build plate")],
  ["Bed.TargetTemperature", number(UNITS.degreeCelsius, "Target temperature of the build plate")],
  ["Bed.Type", text("Type of the build plate, for example glass")],
  ["Position.X", number(UNITS.metre, "Position of the print head on the axis X")],
  ["Position.Y", number(UNITS.metre, "Position of the print head on the axis Y")],
  ["Position.Z", number(UNITS.metre, "Position of the print head on the axis Z")],
  ["FanFraction", number(UNITS.one, "Speed of the fan of the print head as a fraction of its maximum")],
  ["Print.State", text("State of the print job as the API of the printer says it, none without one")],
  ["Print.JobId", text("Id of the print job")],
  ["Print.Name", text("Name of the print job, usually the file name")],
  ["Print.Result", text("Result of the print job as the API of the printer says it")],
  ["Print.Progress", number(UNITS.one, "Progress of the print job as a fraction")],
  ["Print.TimeElapsed", number(UNITS.second, "Time the print job has run")],
  ["Print.TimeTotal", number(UNITS.second, "Time the print job takes in all, as the printer estimates it")],
  ["Print.TimeRemaining", number(UNITS.second, "Time the print job still takes, as the printer estimates it")],
  ["System.Firmware", text("Firmware version of the printer")],
]

/** The signals of one extruder, below Extruder.{index}. */
const EXTRUDER_SIGNALS: ReadonlyArray<[string, (n: number) => Signal]> = [
  ["Temperature", (n) => number(UNITS.degreeCelsius, `Temperature of the hot end of extruder ${n}`)],
  ["TargetTemperature", (n) => number(UNITS.degreeCelsius, `Target temperature of the hot end of extruder ${n}`)],
  ["MaterialRemainingLength", (n) => number(UNITS.metre, `Length of material left on the spool of extruder ${n}`)],
  ["HotendId", (n) => text(`Print core in extruder ${n}, for example AA 0.4`)],
  ["MaterialBrand", (n) => text(`Brand of the material loaded in extruder ${n}`)],
  ["MaterialType", (n) => text(`Type of the material loaded in extruder ${n}, for example PLA`)],
  ["MaterialColor", (n) => text(`Colour of the material loaded in extruder ${n}`)],
  ["MaterialColorCode", (n) => text(`Colour of the material loaded in extruder ${n} as #rrggbb`)],
]

/** Every signal of a printer with `extruders` extruders: paths below the prefix, with what the manifest says. */
export function signals(extruders: number): Array<[string, Signal]> {
  const out = SIGNALS.map(([path, signal]): [string, Signal] => [`${ROOT}.${path}`, signal])
  for (let i = 0; i < extruders; i++) {
    for (const [name, describe] of EXTRUDER_SIGNALS) out.push([`${ROOT}.Extruder.${i}.${name}`, describe(i)])
  }
  return out
}

/** How many extruders the printer reports. */
export const extrudersOf = (printer: Printer) => printer.heads?.[0]?.extruders?.length ?? 0

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const mm = (value: number) => value / 1000
/** A fraction 0..1. Some firmware reports a percentage 0..100 instead. */
const ratio = (value: number) => (value > 1 ? value / 100 : value)

/** The whole of what the printer says now; a value it does not give is left out. */
export function valuesOf(snapshot: Snapshot, identity: Identity, at: Date): Array<MachineValue> {
  const out: Array<MachineValue> = []
  const signal = (relative: string) => identity.signal(`${ROOT}.${relative}`)
  const num = (relative: string, value: unknown, unit: Unit, convert: (v: number) => number = (v) => v) => {
    // 12 significant digits drop the noise of the conversion (0.0972 instead of 0.09720000000000001).
    if (isNumber(value)) out.push({ path: signal(relative), value: Number(convert(value).toPrecision(12)), unit: unit.name, timestamp: at })
  }
  const str = (relative: string, value: unknown) => {
    if (typeof value === "string" && value !== "") out.push({ path: signal(relative), value, timestamp: at })
  }

  const { status, printer, job, system } = snapshot
  const jobState = job?.state

  out.push({
    path: STATUS,
    value: { MachineryItemState: machineryItemState(status, jobState), MachineryOperationMode: machineryOperationMode(status, jobState) },
    timestamp: at,
  })

  str("PrinterStatus", status)
  num("Bed.Temperature", printer.bed?.temperature?.current, UNITS.degreeCelsius)
  num("Bed.TargetTemperature", printer.bed?.temperature?.target, UNITS.degreeCelsius)
  str("Bed.Type", printer.bed?.type)

  const head = printer.heads?.[0]
  num("Position.X", head?.position?.x, UNITS.metre, mm)
  num("Position.Y", head?.position?.y, UNITS.metre, mm)
  num("Position.Z", head?.position?.z, UNITS.metre, mm)
  num("FanFraction", head?.fan, UNITS.one, ratio)

  ;(head?.extruders ?? []).forEach((extruder, i) => {
    const ex = `Extruder.${i}`
    num(`${ex}.Temperature`, extruder.hotend?.temperature?.current, UNITS.degreeCelsius)
    num(`${ex}.TargetTemperature`, extruder.hotend?.temperature?.target, UNITS.degreeCelsius)
    str(`${ex}.HotendId`, extruder.hotend?.id)
    const material = extruder.active_material
    const remaining = material?.length_remaining
    if (isNumber(remaining) && remaining >= 0) num(`${ex}.MaterialRemainingLength`, remaining, UNITS.metre, mm)
    const guid = material?.GUID || material?.guid
    const known = guid ? snapshot.materials.get(guid) : undefined
    if (known) {
      str(`${ex}.MaterialBrand`, known.brand)
      str(`${ex}.MaterialType`, known.material)
      str(`${ex}.MaterialColor`, known.color)
      str(`${ex}.MaterialColorCode`, known.colorCode)
    }
  })

  // Without a job only its state is sent, as "none". The user who sent the job is not published.
  str("Print.State", jobState ?? "none")
  if (job) {
    str("Print.JobId", job.uuid)
    str("Print.Name", job.name)
    str("Print.Result", job.result)
    if (isNumber(job.progress) && job.progress >= 0) num("Print.Progress", Math.min(job.progress, 1), UNITS.one)
    if (isNumber(job.time_elapsed) && job.time_elapsed >= 0) num("Print.TimeElapsed", job.time_elapsed, UNITS.second)
    if (isNumber(job.time_total) && job.time_total >= 0) num("Print.TimeTotal", job.time_total, UNITS.second)
    if (isNumber(job.time_total) && isNumber(job.time_elapsed)) {
      num("Print.TimeRemaining", Math.max(0, job.time_total - job.time_elapsed), UNITS.second)
    }
  }

  str("System.Firmware", system?.firmware)
  return out
}
