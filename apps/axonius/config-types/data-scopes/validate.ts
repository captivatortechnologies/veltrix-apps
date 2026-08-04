import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseText, parseNameList } from './_shared'

/**
 * Validate data-scope items: a non-empty name (the upsert identity) and at
 * least one devices or users saved-query reference — Axonius itself requires a
 * data scope to declare at least one asset scope of either type (verified
 * against `DataScope.update_scopes`'s own guard in axonius_api_client). Static —
 * no target access; the referenced saved-query names are resolved (and can
 * fail) at deploy time, since validate has no guaranteed target connection.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one data scope.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = parseText(item.fields.name)
    const devicesQueries = parseNameList(item.fields.devices_queries)
    const usersQueries = parseNameList(item.fields.users_queries)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Data scope name is required.', code: 'EMPTY_NAME' })
    }

    if (devicesQueries.length === 0 && usersQueries.length === 0) {
      errors.push({
        field: `items[${i}].devices_queries`,
        message: `Data scope "${name || i}" needs at least one devices or users saved-query reference.`,
        code: 'EMPTY_SCOPES',
      })
    }

    if (name) {
      if (seen.has(name)) {
        warnings.push({ field: `items[${i}].name`, message: `Data scope "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(name)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
