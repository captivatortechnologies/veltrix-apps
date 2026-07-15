import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare DNS constraints ----------------------------------------------

export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'] as const
/** Types for which the `proxied` (orange-cloud) flag is valid. */
export const PROXYABLE_TYPES = new Set(['A', 'AAAA', 'CNAME'])
/** Types that require a `priority`. */
export const PRIORITY_TYPES = new Set(['MX', 'SRV'])

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface DnsRecordSpec {
  sectionName: string
  type: string
  name: string
  content: string
  ttl: number
  proxied: boolean
  priority?: number
}

/** Shape of a DNS record returned by GET /dns_records. */
export interface LiveDnsRecord {
  id?: string
  type?: string
  name?: string
  content?: string
  ttl?: number
  proxied?: boolean
  priority?: number
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** The (type, name, content) natural key for a record — a record's logical identity. */
export function dnsRecordKey(spec: { type: string; name: string; content: string }): string {
  return JSON.stringify([spec.type.toUpperCase(), spec.name.toLowerCase(), spec.content])
}

/** Each canvas item describes one Cloudflare DNS record. */
export function extractDnsRecordSpecs(canvas: CanvasSnapshot): DnsRecordSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      type: typeof fields.type === 'string' ? fields.type.trim().toUpperCase() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      content: typeof fields.content === 'string' ? fields.content.trim() : '',
      ttl: readNumber(fields.ttl) ?? 1,
      proxied: readBool(fields.proxied, false),
      priority: readNumber(fields.priority),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate DNS record configurations against Cloudflare constraints: type, name
 * and content are required; the type must be supported; MX/SRV require a
 * priority; `proxied` is only valid for A/AAAA/CNAME (warned otherwise); and the
 * (type, name, content) natural key must be unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDnsRecordSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Record type is required', code: 'required' })
    } else if (!DNS_TYPES.includes(spec.type as (typeof DNS_TYPES)[number])) {
      errors.push({ field: `${prefix}.type`, message: `Unsupported record type "${spec.type}"`, code: 'invalid_type' })
    }
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Record name is required', code: 'required' })
    }
    if (!spec.content) {
      errors.push({ field: `${prefix}.content`, message: 'Record content is required', code: 'required' })
    }
    if (PRIORITY_TYPES.has(spec.type) && spec.priority === undefined) {
      errors.push({ field: `${prefix}.priority`, message: `${spec.type} records require a priority`, code: 'required' })
    }
    if (spec.proxied && !PROXYABLE_TYPES.has(spec.type)) {
      warnings.push({
        field: `${prefix}.proxied`,
        message: `"Proxied" is only valid for A / AAAA / CNAME — it will be ignored for ${spec.type}`,
        code: 'proxied_ignored',
      })
    }

    if (spec.type && spec.name && spec.content) {
      const key = dnsRecordKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.content`,
          message: `Duplicate DNS record "${spec.type} ${spec.name} ${spec.content}" — each (type, name, content) may only be declared once`,
          code: 'duplicate_dns_record',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
