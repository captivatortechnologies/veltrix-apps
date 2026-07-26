import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Mimecast blocked sender policy constraints ------------------------------

export const OPTIONS = ['block_sender', 'no_action'] as const
export const BLOCK_TYPES = ['everyone', 'email_domain', 'email_address'] as const

export interface BlockedSenderSpec {
  itemId?: string
  /** description — the logical identity (policies are id-addressed). */
  description: string
  /** block_sender | no_action. */
  option: string
  fromType: string
  fromValue: string
  toType: string
  toValue: string
}

/** A blocked sender policy as returned by get-all. */
export interface LivePolicy {
  id?: string
  option?: string
  policy?: {
    description?: string
    from?: { type?: string; emailAddress?: string; emailDomain?: string }
    to?: { type?: string; emailAddress?: string; emailDomain?: string }
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractBlockedSenderSpecs(canvas: CanvasSnapshot): BlockedSenderSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asString(f.description) || item.name,
      option: (asString(f.option) || 'block_sender').toLowerCase(),
      fromType: (asString(f.fromType) || 'email_domain').toLowerCase(),
      fromValue: asString(f.fromValue),
      toType: (asString(f.toType) || 'everyone').toLowerCase(),
      toValue: asString(f.toValue),
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
  const specs = extractBlockedSenderSpecs(ctx.canvas)
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
  })

  return { valid: errors.length === 0, errors, warnings }
}
