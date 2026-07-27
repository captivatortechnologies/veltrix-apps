import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager wildcard-FQDN (custom) address constraints -----------------

export const MAX_NAME_LENGTH = 79
/** Wildcard FQDN — domain labels with optional "*" wildcard segments. */
const WILDCARD_FQDN_RE = /^[A-Za-z0-9*][A-Za-z0-9.*_-]*\.[A-Za-z0-9*][A-Za-z0-9.*_-]*$/

export interface WildcardFqdnSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** The wildcard FQDN pattern, e.g. *.example.com. */
  wildcardFqdn: string
  comment: string
}

/** A wildcard-FQDN as returned by a get on the wildcard-fqdn/custom table. */
export interface LiveWildcardFqdn {
  name?: string
  'wildcard-fqdn'?: string
  comment?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function isValidWildcardFqdn(value: string): boolean {
  return WILDCARD_FQDN_RE.test(value)
}

export function extractWildcardFqdnSpecs(canvas: CanvasSnapshot): WildcardFqdnSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      wildcardFqdn: asString(f.wildcardFqdn),
      comment: asString(f.comment),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractWildcardFqdnSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate wildcard FQDN "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.wildcardFqdn) {
      errors.push({ field: `${prefix}.wildcardFqdn`, message: 'A wildcard FQDN pattern is required', code: 'missing_wildcard_fqdn' })
    } else if (!isValidWildcardFqdn(spec.wildcardFqdn)) {
      errors.push({ field: `${prefix}.wildcardFqdn`, message: `"${spec.wildcardFqdn}" is not a valid wildcard FQDN (e.g. *.example.com)`, code: 'invalid_wildcard_fqdn' })
    } else if (!spec.wildcardFqdn.includes('*')) {
      warnings.push({ field: `${prefix}.wildcardFqdn`, message: 'This pattern has no "*" wildcard — a plain FQDN is better modelled as a Firewall Address (fqdn type)', code: 'no_wildcard' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
