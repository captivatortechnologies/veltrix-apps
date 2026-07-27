import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Mimecast anti-spoofing bypass policy constraints ------------------------

export const OPTIONS = ['enable_bypass', 'disable_bypass'] as const
export const BLOCK_TYPES = ['everyone', 'email_domain', 'email_address'] as const

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

export interface AntiSpoofingBypassSpec {
  itemId?: string
  /** description — the logical identity (policies are id-addressed). */
  description: string
  /** enable_bypass | disable_bypass. */
  option: string
  fromType: string
  fromValue: string
  toType: string
  toValue: string
  /** SPF domains the bypass applies to. */
  spfDomains: string[]
}

/** An anti-spoofing bypass policy as returned by get-policy. */
export interface LivePolicy {
  id?: string
  option?: string
  conditions?: { spfDomains?: string[] }
  policy?: {
    description?: string
    from?: { type?: string; emailAddress?: string; emailDomain?: string }
    to?: { type?: string; emailAddress?: string; emailDomain?: string }
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse a textarea / list field into a de-blanked string[]. */
export function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
  return []
}

export function extractAntiSpoofingBypassSpecs(canvas: CanvasSnapshot): AntiSpoofingBypassSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asString(f.description) || item.name,
      option: (asString(f.option) || 'enable_bypass').toLowerCase(),
      fromType: (asString(f.fromType) || 'email_domain').toLowerCase(),
      fromValue: asString(f.fromValue),
      toType: (asString(f.toType) || 'everyone').toLowerCase(),
      toValue: asString(f.toValue),
      spfDomains: parseList(f.spfDomains),
    }
  })
}

function validateBlock(type: string, value: string, prefix: string, side: string, errors: ValidationResult['errors']): void {
  if (!(BLOCK_TYPES as readonly string[]).includes(type)) {
    errors.push({ field: `${prefix}.${side}Type`, message: `${side} type must be one of: ${BLOCK_TYPES.join(', ')}`, code: 'invalid_type' })
    return
  }
  if ((type === 'email_domain' || type === 'email_address') && !value) {
    errors.push({ field: `${prefix}.${side}Value`, message: `${side} needs a ${type === 'email_domain' ? 'domain' : 'email address'}`, code: 'missing_value' })
  }
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAntiSpoofingBypassSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required (it is the policy identity)', code: 'required' })
    } else {
      const key = spec.description.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.description`, message: `Duplicate policy "${spec.description}"`, code: 'duplicate_description' })
      }
      seen.add(key)
    }

    if (!(OPTIONS as readonly string[]).includes(spec.option)) {
      errors.push({ field: `${prefix}.option`, message: `Option must be one of: ${OPTIONS.join(', ')}`, code: 'invalid_option' })
    }

    validateBlock(spec.fromType, spec.fromValue, prefix, 'from', errors)
    validateBlock(spec.toType, spec.toValue, prefix, 'to', errors)

    for (const d of spec.spfDomains) {
      if (!DOMAIN_RE.test(d)) {
        warnings.push({ field: `${prefix}.spfDomains`, message: `"${d}" does not look like a valid SPF domain`, code: 'implausible_domain' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
