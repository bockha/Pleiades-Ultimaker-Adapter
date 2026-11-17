// Read access to the local API of an Ultimaker 3 (http://<printer>/api/v1). Reading needs no
// authentication. Only the fields the adapter uses are typed; every one of them is optional,
// because firmware versions differ.

export type Temperature = { current?: number; target?: number }

export type Hotend = {
  id?: string
  serial?: string
  temperature?: Temperature
  offset?: { state?: string; x?: number; y?: number; z?: number } // mm
  statistics?: {
    last_material_guid?: string
    material_extruded?: number // mm of filament
    max_temperature_exposed?: number // °C
    time_spent_hot?: number // s
  }
}

export type Extruder = {
  hotend?: Hotend
  feeder?: { max_speed?: number; acceleration?: number } // mm/s, mm/s²
  active_material?: { GUID?: string; guid?: string; length_remaining?: number } // mm, -1 if unknown
}

export type Head = {
  position?: { x?: number; y?: number; z?: number } // mm
  max_speed?: { x?: number; y?: number; z?: number } // mm/s
  acceleration?: number // mm/s²
  fan?: number // 0..1 or 0..100, depending on firmware
  extruders?: Array<Extruder>
}

export type Printer = {
  status?: string
  bed?: { temperature?: Temperature; pre_heat?: { active?: boolean }; type?: string }
  heads?: Array<Head>
  network?: { wifi?: { connected?: boolean }; ethernet?: { connected?: boolean } }
  led?: { hue?: number; saturation?: number; brightness?: number }
}

export type PrintJob = {
  name?: string
  uuid?: string
  state?: string
  result?: string
  progress?: number // 0..1
  time_elapsed?: number // s
  time_total?: number // s
  source?: string
  source_user?: string
  source_application?: string
  datetime_started?: string
  datetime_finished?: string
}

export type System = {
  name?: string
  hostname?: string
  firmware?: string
  platform?: string
  type?: string
  variant?: string
  guid?: string
  country?: string
  language?: string
  uptime?: number // s
  memory?: { total?: number; used?: number } // bytes
}

export type HistoryEvent = { time?: string; type_id?: number; message?: string; parameters?: Array<unknown> }

export type Material = { brand?: string; material?: string; color?: string; colorCode?: string }

export class NotFound extends Error {}

export class UltimakerClient {
  readonly baseUrl: string
  readonly timeoutMs: number

  constructor(baseUrl: string, timeoutMs: number) {
    this.baseUrl = baseUrl
    this.timeoutMs = timeoutMs
  }

  private async get(path: string): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/api/v1/${path}`, { signal: AbortSignal.timeout(this.timeoutMs) })
    if (response.status === 404) throw new NotFound(path)
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`)
    return response
  }

  private async json<T>(path: string): Promise<T> {
    return (await (await this.get(path)).json()) as T
  }

  printer = () => this.json<Printer>("printer")
  /** idle, printing, error, maintenance or booting. Answered as a JSON string. */
  status = () => this.json<string>("printer/status")
  system = () => this.json<System>("system")

  /** The current print job, or null if there is none (the printer answers 404). */
  async printJob(): Promise<PrintJob | null> {
    try {
      return await this.json<PrintJob>("print_job")
    } catch (error) {
      if (error instanceof NotFound) return null
      throw error
    }
  }

  /** The newest entries of the printer's event log, or null if the firmware has none. */
  async events(count = 20): Promise<Array<HistoryEvent> | null> {
    try {
      const events = await this.json<unknown>(`history/events?count=${count}`)
      return Array.isArray(events) ? (events as Array<HistoryEvent>) : null
    } catch (error) {
      if (error instanceof NotFound) return null
      throw error
    }
  }

  /** Brand, material and colour of a material profile, read from its XML (fdmmaterial). */
  async material(guid: string): Promise<Material> {
    const body = await (await this.get(`materials/${encodeURIComponent(guid)}`)).text()
    // Firmware 5 answers with the XML as a JSON string.
    return parseMaterial(body.trimStart().startsWith('"') ? (JSON.parse(body) as string) : body)
  }
}

export function parseMaterial(xml: string): Material {
  const name = /<name>([\s\S]*?)<\/name>/.exec(xml)?.[1] ?? ""
  const tag = (t: string) => /<(\w+:)?TAG>([^<]*)<\/(\w+:)?TAG>/.source.replaceAll("TAG", t)
  const field = (t: string) => new RegExp(tag(t)).exec(name)?.[2]?.trim() || undefined
  const colorCode = /<(\w+:)?color_code>([^<]*)</.exec(xml)?.[2]?.trim() || undefined
  return { brand: field("brand"), material: field("material"), color: field("color"), colorCode }
}
