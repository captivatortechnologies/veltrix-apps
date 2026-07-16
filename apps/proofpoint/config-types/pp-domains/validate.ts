import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Proofpoint Essentials domain constraints --------------------------------
//
// A domain is a sub-resource of the organization (/orgs/{org}/domains). Its
// identity is the domain name. Managed fields: is_active (accept mail for the
// domain), is_relay (deliver via a relay/smart host instead of MX lookup),
// destination (the relay host/IP when is_relay is true) and failovers (backup
// relay hosts). See help.proofpoint.com Essentials "API // Domains".

// A pragmatic hostname/domain check: labels of letters/digits/hyphens separated
// by dots, at least one dot, TLD of 2+ letters. Not a full RFC validation.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
// A destination is a hostname or an IPv4 address.
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

export interface DomainSpec {
  sectionName: string
  name: string
  isActive: boolean
  isRelay: boolean
  destination: string
  failovers: string[]
}

/** Shape of a domain returned by GET /orgs/{org}/domains. */
export interface LiveDomain {
  name?: string
  is_active?: boolean
  is_relay?: boolean
  destination?: string
  failovers?: string[]
}

/** The domain name (lower-cased) — a domain's logical identity in an org. */
export function domainKey(name: string): string {
  return name.trim().toLowerCase()
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

function readList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[\s,;]+/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Each canvas item describes one Proofpoint Essentials domain. */
export function extractDomainSpecs(canvas: CanvasSnapshot): DomainSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      isActive: readBool(fields.is_active, true),
      isRelay: readBool(fields.is_relay, false),
      destination: typeof fields.destination === 'string' ? fields.destination.trim() : '',
      failovers: readList(fields.failovers),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate domain configurations against Essentials constraints: the domain name
 * is required and must look like a domain; a relay domain (is_relay) requires a
 * destination host/IP; destination and failover entries are warned when they are
 * not a hostname or IPv4; and the domain name (natural key) must be unique across
 * the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDomainSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Domain name is required', code: 'required' })
    } else if (!DOMAIN_RE.test(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: `"${spec.name}" is not a valid domain name`, code: 'invalid_domain' })
    }

    if (spec.isRelay && !spec.destination) {
      errors.push({
        field: `${prefix}.destination`,
        message: 'A relay domain (Relay delivery enabled) requires a destination host or IP',
        code: 'relay_needs_destination',
      })
    }

    if (spec.destination && !isHostOrIp(spec.destination)) {
      warnings.push({
        field: `${prefix}.destination`,
        message: `Destination "${spec.destination}" is not a hostname or IPv4 address`,
        code: 'destination_format',
      })
    }

    for (const failover of spec.failovers) {
      if (!isHostOrIp(failover)) {
        warnings.push({
          field: `${prefix}.failovers`,
          message: `Failover "${failover}" is not a hostname or IPv4 address`,
          code: 'failover_format',
        })
      }
    }

    if (spec.name) {
      const key = domainKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate domain "${spec.name}" — each domain may only be declared once`,
          code: 'duplicate_domain',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

function isHostOrIp(value: string): boolean {
  return DOMAIN_RE.test(value) || IPV4_RE.test(value)
}
