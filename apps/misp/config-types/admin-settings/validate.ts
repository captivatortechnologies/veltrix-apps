import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { YES_NO } from './_shared'

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$/

/**
 * Validate admin-setting items: a non-empty, dotted setting name, a non-empty
 * value, and a known force value. Static — no target access required (whether a
 * setting exists, is redacted, or is CLI-only is only known at deploy time). The
 * name doubles as the setting identity, so a duplicate name is flagged (last one
 * wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one setting.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const value = String(item.fields.value ?? '').trim()
    const force = String(item.fields.force ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Setting name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_PATTERN.test(name)) {
      errors.push({ field: `items[${i}].name`, message: `Setting name must be dotted, e.g. MISP.host_org_id (got "${name}").`, code: 'INVALID_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Setting "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!value) {
      errors.push({ field: `items[${i}].value`, message: 'Value is required.', code: 'EMPTY_VALUE' })
    }

    if (!YES_NO.has(force)) {
      errors.push({ field: `items[${i}].force`, message: `Force must be yes or no (got "${force}").`, code: 'INVALID_FORCE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
