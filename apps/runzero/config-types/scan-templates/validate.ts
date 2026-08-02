import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readKeyValueMap, text } from './_shared'

/**
 * Validate Scan Template items: a non-empty name is required (it doubles as the template
 * identity). Parameter keys are checked for blanks. Static — no target access required. A
 * duplicate name is flagged (last wins). Note the account-scope requirement is a deploy-time
 * concern, surfaced by healthCheck, not something validate can assert statically.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one scan template.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = text(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Template name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Template name "${name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(name.toLowerCase())
    }

    const params = item.fields.params
    if (params !== undefined && params !== null && Object.keys(readKeyValueMap(params)).length === 0 && hasRows(params)) {
      warnings.push({
        field: `items[${i}].params`,
        message: 'Scan parameters have a row with no key — blank-keyed rows are dropped.',
        code: 'EMPTY_PARAM_KEY',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

/** True when the raw params value carries at least one row/entry (so an all-blank-key set is detectable). */
function hasRows(params: unknown): boolean {
  if (Array.isArray(params)) return params.length > 0
  if (params && typeof params === 'object') return Object.keys(params as Record<string, unknown>).length > 0
  if (typeof params === 'string') return params.trim().length > 0
  return false
}
