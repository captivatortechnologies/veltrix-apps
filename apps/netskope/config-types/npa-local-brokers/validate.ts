import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope NPA local broker (LBR) constraints -----------------------------

export const ACCESS_VIA_PUBLIC_IP = ['NONE', 'OFF_PREM', 'ON_PREM', 'ON_OFF_PREM'] as const
export type AccessViaPublicIp = (typeof ACCESS_VIA_PUBLIC_IP)[number]

export interface LocalBrokerSpec {
  itemId?: string
  /** local_broker_name — the logical identity (brokers are id-addressed). */
  name: string
  accessViaPublicIp: string
  customPrivateIp: string
  customPublicIp: string
  /** RBAC label NAMES; resolved to label_ids against the live labels at deploy. */
  labels: string[]
  latitude?: number
  longitude?: number
  cityName: string
  regionName: string
  countryName: string
  countryCode: string
}

/** A local broker as returned by GET /api/v2/infrastructure/lbrokers. Registration
 *  state and dns_host are runtime read-only fields and are not managed here. */
export interface LiveLocalBroker {
  local_broker_id?: number | string
  id?: number | string
  local_broker_name?: string
  access_via_public_ip?: string
  custom_private_ip?: string
  custom_public_ip?: string
  label_ids?: Array<string | number>
  latitude?: number
  longitude?: number
  city_name?: string
  region_name?: string
  country_name?: string
  country_code?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asOptionalNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const s = asString(v)
  if (!s) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

export function splitEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function liveLocalBrokerId(l: LiveLocalBroker): string | undefined {
  const v = l.local_broker_id ?? l.id
  return v === undefined || v === null ? undefined : String(v)
}

export function extractLocalBrokerSpecs(canvas: CanvasSnapshot): LocalBrokerSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.local_broker_name) || item.name,
      accessViaPublicIp: asString(f.access_via_public_ip) || 'NONE',
      customPrivateIp: asString(f.custom_private_ip),
      customPublicIp: asString(f.custom_public_ip),
      labels: splitEntries(f.labels),
      latitude: asOptionalNumber(f.latitude),
      longitude: asOptionalNumber(f.longitude),
      cityName: asString(f.city_name),
      regionName: asString(f.region_name),
      countryName: asString(f.country_name),
      countryCode: asString(f.country_code),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractLocalBrokerSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.local_broker_name`, message: 'Local broker name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.local_broker_name`, message: `Duplicate local broker "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!ACCESS_VIA_PUBLIC_IP.includes(spec.accessViaPublicIp as AccessViaPublicIp)) {
      errors.push({ field: `${prefix}.access_via_public_ip`, message: `Access via public IP must be one of ${ACCESS_VIA_PUBLIC_IP.join(', ')}`, code: 'invalid_enum' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
