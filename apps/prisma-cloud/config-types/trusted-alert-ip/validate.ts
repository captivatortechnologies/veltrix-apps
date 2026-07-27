import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud trusted alert IP constraints -------------------------------
// Distinct from the login IP allow list: this excludes IPs from NETWORK ANOMALY
// alerting, not console login.

export const MAX_NAME_LENGTH = 255

/** Loose CIDR check — IPv4/IPv6 address followed by an optional /prefix. */
const CIDR_RE = /^([0-9]{1,3}(\.[0-9]{1,3}){3}(\/([0-9]|[12][0-9]|3[0-2]))?|[0-9a-fA-F:]+(\/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8]))?)$/

export interface TrustedCidr {
  cidr: string
  description?: string
}

export interface TrustedAlertIpSpec {
  itemId?: string
  /** name — the identity (Prisma matches trusted alert IPs by name). */
  name: string
  /** the CIDR entries, each { cidr, description }. */
  cidrs: TrustedCidr[]
  /** set when the raw cidrs value could not be parsed as a JSON array. */
  cidrsError?: string
}

/** A trusted alert IP as returned by GET /allow_list/network. */
export interface LiveTrustedAlertIp {
  uuid?: string
  name?: string
  cidrCount?: number
  cidrs?: Array<{ cidr?: string; description?: string; uuid?: string; createdOn?: number }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseCidrs(v: unknown): { cidrs: TrustedCidr[]; cidrsError?: string } {
  if (Array.isArray(v)) return normalize(v)
  if (v === null || v === undefined) return { cidrs: [] }
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return { cidrs: [] }
    try {
      const parsed = JSON.parse(t)
      if (Array.isArray(parsed)) return normalize(parsed)
      return { cidrs: [], cidrsError: 'CIDRs must be a JSON array' }
    } catch {
      return { cidrs: [], cidrsError: 'CIDRs must be valid JSON' }
    }
  }
  return { cidrs: [], cidrsError: 'CIDRs must be a JSON array' }
}

function normalize(arr: unknown[]): { cidrs: TrustedCidr[]; cidrsError?: string } {
  const cidrs: TrustedCidr[] = []
  for (const el of arr) {
    if (typeof el === 'string') {
      cidrs.push({ cidr: el.trim() })
    } else if (isObject(el) && typeof el.cidr === 'string') {
      cidrs.push({ cidr: (el.cidr as string).trim(), description: typeof el.description === 'string' ? el.description : undefined })
    } else {
      return { cidrs: [], cidrsError: 'Each CIDR entry must be a string or an object with a "cidr" field' }
    }
  }
  return { cidrs }
}

export function extractTrustedAlertIpSpecs(canvas: CanvasSnapshot): TrustedAlertIpSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const { cidrs, cidrsError } = parseCidrs(f.cidrs)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      cidrs,
      cidrsError,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTrustedAlertIpSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate trusted alert IP "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.cidrsError) {
      errors.push({ field: `${prefix}.cidrs`, message: spec.cidrsError, code: 'invalid_cidrs' })
    } else if (spec.cidrs.length === 0) {
      errors.push({ field: `${prefix}.cidrs`, message: 'At least one CIDR entry is required', code: 'required' })
    } else {
      for (const c of spec.cidrs) {
        if (!CIDR_RE.test(c.cidr)) {
          errors.push({ field: `${prefix}.cidrs`, message: `"${c.cidr}" is not a valid CIDR block`, code: 'invalid_cidr' })
        }
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
