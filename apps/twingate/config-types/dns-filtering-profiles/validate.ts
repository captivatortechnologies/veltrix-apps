import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  CONTENT_CATEGORY_FLAGS,
  FALLBACK_METHODS,
  PRIVACY_CATEGORY_FLAGS,
  SECURITY_CATEGORY_FLAGS,
  extractDnsFilteringProfileSpecs,
  profileKey,
} from './_shared'

const CONTENT_KEYS = new Set(CONTENT_CATEGORY_FLAGS.map((f) => f.key))
const SECURITY_KEYS = new Set(SECURITY_CATEGORY_FLAGS.map((f) => f.key))
const PRIVACY_KEYS = new Set(PRIVACY_CATEGORY_FLAGS.map((f) => f.key))

/**
 * Validate Twingate DNS Filtering Profile configurations: name and a numeric
 * priority are required; name must be unique across the canvas
 * (case-insensitive); `fallback_method` and every selected category flag must
 * be a supported value. Purely static: no live Twingate calls.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDnsFilteringProfileSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.itemName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Profile name is required', code: 'required' })
    }
    if (!Number.isFinite(spec.priority)) {
      errors.push({ field: `${prefix}.priority`, message: 'Priority must be a number', code: 'invalid_priority' })
    }
    if (!FALLBACK_METHODS.includes(spec.fallbackMethod as (typeof FALLBACK_METHODS)[number])) {
      errors.push({
        field: `${prefix}.fallback_method`,
        message: `Unsupported fallback method "${spec.fallbackMethod}"`,
        code: 'invalid_fallback_method',
      })
    }

    checkFlags(spec.contentFlags, CONTENT_KEYS, `${prefix}.content_categories`, errors)
    checkFlags(spec.securityFlags, SECURITY_KEYS, `${prefix}.security_categories`, errors)
    checkFlags(spec.privacyFlags, PRIVACY_KEYS, `${prefix}.privacy_categories`, errors)

    if (spec.name) {
      const key = profileKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate DNS Filtering Profile "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_profile',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

function checkFlags(selected: string[], known: Set<string>, field: string, errors: ValidationResult['errors']): void {
  for (const flag of selected) {
    if (!known.has(flag)) {
      errors.push({ field, message: `Unsupported category flag "${flag}"`, code: 'invalid_category_flag' })
    }
  }
}
