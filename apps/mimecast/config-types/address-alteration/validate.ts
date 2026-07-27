import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Mimecast address alteration policy constraints --------------------------

export const FROM_PARTS = ['envelope_from', 'header_from', 'both'] as const
export const BLOCK_TYPES = ['everyone', 'email_domain', 'email_address'] as const

export interface AddressAlterationSpec {
  itemId?: string
  /** description — the logical identity (policies are id-addressed). */
  description: string
  /** the secure id of the Address Alteration Set this policy applies. */
  addressAlterationSetId: string
  /** envelope_from | header_from | both. */
  fromPart: string
  fromType: string
  fromValue: string
  toType: string
  toValue: string
  enabled: boolean
}

/** An address alteration policy as returned by get-policy. */
export interface LivePolicy {
  id?: string
  addressAlterationSetId?: string
  policy?: {
    description?: string
    fromPart?: string
    enabled?: boolean
    from?: { type?: string; emailAddress?: string; emailDomain?: string }
    to?: { type?: string; emailAddress?: string; emailDomain?: string }
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractAddressAlterationSpecs(canvas: CanvasSnapshot): AddressAlterationSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asString(f.description) || item.name,
      addressAlterationSetId: asString(f.addressAlterationSetId),
      fromPart: (asString(f.fromPart) || 'envelope_from').toLowerCase(),
      fromType: (asString(f.fromType) || 'email_domain').toLowerCase(),
      fromValue: asString(f.fromValue),
      toType: (asString(f.toType) || 'everyone').toLowerCase(),
      toValue: asString(f.toValue),
      enabled: typeof f.enabled === 'boolean' ? f.enabled : true,
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
  const specs = extractAddressAlterationSpecs(ctx.canvas)
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

    if (!spec.addressAlterationSetId) {
      errors.push({ field: `${prefix}.addressAlterationSetId`, message: 'Address Alteration Set ID is required (the set this policy applies)', code: 'required' })
    }

    if (!(FROM_PARTS as readonly string[]).includes(spec.fromPart)) {
      errors.push({ field: `${prefix}.fromPart`, message: `From part must be one of: ${FROM_PARTS.join(', ')}`, code: 'invalid_from_part' })
    }

    validateBlock(spec.fromType, spec.fromValue, prefix, 'from', errors)
    validateBlock(spec.toType, spec.toValue, prefix, 'to', errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}
