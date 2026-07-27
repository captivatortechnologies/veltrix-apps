import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope GRE tunnel constraints -----------------------------------------

export const SOURCE_TYPES = ['User', 'Machine', 'IoT', 'Guest Wifi', 'Mixed'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

export interface GreTunnelSpec {
  itemId?: string
  /** site — the natural key. POP names can drop from list responses, so tunnels
   *  are matched on site (the tunnel_id is stored for rename-safety). */
  site: string
  sourceIp: string
  popNames: string[]
  bandwidth: number
  enabled: boolean
  notes: string
  sourceType: string
  template: string
  vendor: string
  xffEnabled: boolean
  xffIpList: string[]
}

/** A GRE tunnel as returned by GET /api/v2/steering/gre/tunnels (steering {data}). */
export interface LiveGreTunnel {
  tunnel_id?: number | string
  id?: number | string
  site?: string
  source_ip?: string
  pop_names?: string[]
  bandwidth?: number
  enabled?: boolean
  notes?: string
  source_type?: string
  template?: string
  vendor?: string
  options?: { xff?: { xff_enabled?: boolean; xff_ip_list?: string[] } }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(asString(v))
  return Number.isFinite(n) && asString(v) !== '' ? n : fallback
}

export function splitEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function liveGreTunnelId(l: LiveGreTunnel): string | undefined {
  const v = l.tunnel_id ?? l.id
  return v === undefined || v === null ? undefined : String(v)
}

export function extractGreTunnelSpecs(canvas: CanvasSnapshot): GreTunnelSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      site: asString(f.site) || item.name,
      sourceIp: asString(f.source_ip),
      popNames: splitEntries(f.pop_names),
      bandwidth: asNumber(f.bandwidth, 1000),
      enabled: f.enabled !== false,
      notes: asString(f.notes),
      sourceType: asString(f.source_type),
      template: asString(f.template),
      vendor: asString(f.vendor),
      xffEnabled: f.xff_enabled === true,
      xffIpList: splitEntries(f.xff_ip_list),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractGreTunnelSpecs(ctx.canvas)
  const seenSites = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.site) {
      errors.push({ field: `${prefix}.site`, message: 'Site is required', code: 'required' })
    } else {
      const key = spec.site.toLowerCase()
      if (seenSites.has(key)) {
        errors.push({ field: `${prefix}.site`, message: `Duplicate GRE tunnel site "${spec.site}"`, code: 'duplicate_site' })
      }
      seenSites.add(key)
    }

    if (!spec.sourceIp) {
      errors.push({ field: `${prefix}.source_ip`, message: 'Source IP is required', code: 'required' })
    }

    if (spec.popNames.length === 0) {
      errors.push({ field: `${prefix}.pop_names`, message: 'At least one POP name is required', code: 'no_pops' })
    }

    if (spec.bandwidth <= 0) {
      errors.push({ field: `${prefix}.bandwidth`, message: 'Bandwidth must be a positive number (Mbps)', code: 'invalid_bandwidth' })
    }

    if (spec.sourceType && !SOURCE_TYPES.includes(spec.sourceType as SourceType)) {
      errors.push({ field: `${prefix}.source_type`, message: `Source type must be one of ${SOURCE_TYPES.join(', ')}`, code: 'invalid_source_type' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
