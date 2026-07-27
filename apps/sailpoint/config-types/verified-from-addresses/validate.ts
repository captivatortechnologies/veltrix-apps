import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Verified From-Address constraints -------------------------
// Keyed by email. Create + delete only (no update). SES verification is async and
// out-of-band, so drift reports a pending (unverified) address as a warning.

export interface VerifiedFromAddressSpec {
  itemId?: string
  email: string
}

/** A verified from-address as returned by GET /beta/verified-from-addresses. */
export interface LiveVerifiedFromAddress {
  id?: string
  email?: string
  verified?: boolean
  isVerified?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractVerifiedFromAddressSpecs(canvas: CanvasSnapshot): VerifiedFromAddressSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      email: asString(f.email) || item.name,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractVerifiedFromAddressSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.email) {
      errors.push({ field: `${prefix}.email`, message: 'An email address is required', code: 'required' })
    } else {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(spec.email)) {
        errors.push({ field: `${prefix}.email`, message: `"${spec.email}" is not a valid email address`, code: 'invalid_email' })
      }
      const key = spec.email.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.email`, message: `Duplicate email "${spec.email}" — each may only be declared once per canvas`, code: 'duplicate_email' })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
