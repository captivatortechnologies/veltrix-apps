import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar offense closing reason constraints ---------------------------
//
// The API supports create + read only (no update, no delete), so this type is
// APPEND-ONLY: deploy creates any declared reason that is missing, but reasons
// this app created can never be removed or renamed via the API. Identity is the
// reason text (5-60 characters).

export interface ClosingReasonSpec {
  itemId?: string
  text: string
}

/** A closing reason as returned by GET /siem/offense_closing_reasons. */
export interface LiveClosingReason {
  id?: number
  text?: string
  is_deleted?: boolean
  is_reserved?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractClosingReasonSpecs(canvas: CanvasSnapshot): ClosingReasonSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      text: asString(f.text) || item.name,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractClosingReasonSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.text) {
      errors.push({ field: `${prefix}.text`, message: 'Reason text is required', code: 'required' })
    } else {
      if (spec.text.length < 5 || spec.text.length > 60) {
        errors.push({ field: `${prefix}.text`, message: 'Reason text must be 5 to 60 characters', code: 'invalid_length' })
      }
      const key = spec.text.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.text`, message: `Duplicate closing reason "${spec.text}"`, code: 'duplicate_text' })
      }
      seen.add(key)
    }
  })

  if (specs.length > 0) {
    warnings.push({ field: 'items', message: 'Closing reasons are append-only: this app cannot remove or rename reasons it creates', code: 'append_only' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
