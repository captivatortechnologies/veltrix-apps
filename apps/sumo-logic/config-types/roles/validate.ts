import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { toStringList } from './_shared'

/**
 * Validate role items: a non-empty name. Static — no target access required. The
 * role name is the identity, so a duplicate name is flagged (last one wins). A
 * role with no capabilities is allowed but warned (it can sign in but do little).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one role.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Role name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Role name "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (toStringList(item.fields.capabilities).length === 0) {
      warnings.push({
        field: `items[${i}].capabilities`,
        message: `Role "${name || i}" has no capabilities — its members can sign in but perform few actions.`,
        code: 'NO_CAPABILITIES',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
