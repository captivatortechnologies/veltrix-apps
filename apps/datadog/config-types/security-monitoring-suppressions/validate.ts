import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, extractSuppressionSpecs, parseEpochMs, suppressionKey, type SuppressionSpec } from './_shared'

/**
 * Validate Security Monitoring Suppression items — static, no network access.
 *   - name and rule_query are required (rule_query is the only attribute
 *     Datadog's create endpoint documents as required alongside name/enabled).
 *   - name unique across the canvas (case-insensitive).
 *   - start_date / expiration_date, when set, must be finite numbers
 *     (Unix milliseconds); when both are set, expiration_date must be after
 *     start_date.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Suppression Rule.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSuppressionSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors)
    if (spec.name) {
      const key = suppressionKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Duplicate suppression name "${spec.name}" — each name may only be declared once (rules are matched by name).`,
          code: 'DUPLICATE_NAME',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: SuppressionSpec, i: number, errors: ValidationError[]): void {
  const prefix = `items[${i}]`

  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Suppression rule name is required.', code: 'EMPTY_NAME' })
  } else if (spec.name.length > MAX_NAME_LENGTH) {
    errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`, code: 'NAME_TOO_LONG' })
  }

  if (!spec.ruleQuery) {
    errors.push({ field: `${prefix}.rule_query`, message: 'Rule Query is required — it selects which detection rules this suppression applies to.', code: 'EMPTY_RULE_QUERY' })
  }

  let start: number | undefined
  if (spec.startDateRaw) {
    start = parseEpochMs(spec.startDateRaw)
    if (Number.isNaN(start)) {
      errors.push({ field: `${prefix}.start_date`, message: 'Start Date must be a Unix millisecond timestamp (a number).', code: 'INVALID_START_DATE' })
      start = undefined
    }
  }

  let expiration: number | undefined
  if (spec.expirationDateRaw) {
    expiration = parseEpochMs(spec.expirationDateRaw)
    if (Number.isNaN(expiration)) {
      errors.push({ field: `${prefix}.expiration_date`, message: 'Expiration Date must be a Unix millisecond timestamp (a number).', code: 'INVALID_EXPIRATION_DATE' })
      expiration = undefined
    }
  }

  if (start !== undefined && expiration !== undefined && expiration <= start) {
    errors.push({
      field: `${prefix}.expiration_date`,
      message: 'Expiration Date must be after Start Date.',
      code: 'EXPIRATION_BEFORE_START',
    })
  }
}
