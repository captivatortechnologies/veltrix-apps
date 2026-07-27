import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope DNS security profile constraints -------------------------------

export const LOG_TRAFFIC_VALUES = ['Blocked DNS', 'All DNS'] as const
export type LogTraffic = (typeof LOG_TRAFFIC_VALUES)[number]

export interface DnsProfileSpec {
  itemId?: string
  /** name — the logical identity (profiles are id-addressed; the app matches on
   *  name and stores the profile_id for rename-safety). */
  name: string
  description: string
  logTraffic: string
  /** Raw JSON for the three nested config blobs (managed as validated JSON). */
  domainConfigRaw: string
  tunnelConfigRaw: string
  customConfigRaw: string
}

/** A DNS profile as returned by GET /api/v2/profiles/dns (bare object). */
export interface LiveDnsProfile {
  profile_id?: string
  id?: string | number
  name?: string
  description?: string
  log_traffic?: string
  status?: string
  domain_config?: Record<string, unknown>
  tunnel_config?: Record<string, unknown>
  custom_config?: Record<string, unknown>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function liveDnsProfileId(l: LiveDnsProfile): string | undefined {
  const v = l.profile_id ?? l.id
  return v === undefined || v === null ? undefined : String(v)
}

/** Parse a JSON-object config blob field. An empty value is "not provided". */
export function parseConfigBlob(v: unknown): { provided: boolean; value?: Record<string, unknown>; error?: string } {
  const raw = asString(v)
  if (!raw) return { provided: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { provided: true, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { provided: true, error: 'must be a JSON object' }
  }
  return { provided: true, value: parsed as Record<string, unknown> }
}

export function extractDnsProfileSpecs(canvas: CanvasSnapshot): DnsProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      logTraffic: asString(f.log_traffic) || 'Blocked DNS',
      domainConfigRaw: asString(f.domain_config),
      tunnelConfigRaw: asString(f.tunnel_config),
      customConfigRaw: asString(f.custom_config),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDnsProfileSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Profile name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate DNS profile "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!LOG_TRAFFIC_VALUES.includes(spec.logTraffic as LogTraffic)) {
      errors.push({ field: `${prefix}.log_traffic`, message: `Log traffic must be one of ${LOG_TRAFFIC_VALUES.join(', ')}`, code: 'invalid_enum' })
    }

    for (const [field, raw] of [
      ['domain_config', spec.domainConfigRaw],
      ['tunnel_config', spec.tunnelConfigRaw],
      ['custom_config', spec.customConfigRaw],
    ] as const) {
      const parsed = parseConfigBlob(raw)
      if (parsed.error) {
        errors.push({ field: `${prefix}.${field}`, message: `${field} is not valid JSON: ${parsed.error}`, code: 'invalid_json' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
