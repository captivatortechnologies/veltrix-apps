import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { APPLICATION_TYPES, isValidConnectionConfig } from './_shared'

/**
 * Validate external-application items: a non-empty name, a known application
 * type, and valid JSON for connection_config. Static — no target access
 * required. The name doubles as the application's identity, so a duplicate is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one external application.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const applicationType = String(item.fields.application_type ?? '').trim().toLowerCase()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Application "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!APPLICATION_TYPES.has(applicationType)) {
      errors.push({ field: `items[${i}].application_type`, message: `Application type must be one of ${[...APPLICATION_TYPES].join(', ')} (got "${applicationType}").`, code: 'INVALID_APPLICATION_TYPE' })
    }

    if (!isValidConnectionConfig(item.fields.connection_config)) {
      errors.push({ field: `items[${i}].connection_config`, message: 'Connection config must be a valid JSON object.', code: 'INVALID_CONNECTION_CONFIG' })
    } else {
      const raw = String(item.fields.connection_config ?? '').trim()
      if (!raw) {
        warnings.push({ field: `items[${i}].connection_config`, message: 'Connection config is empty — most application types require provider-specific fields (see the README).', code: 'EMPTY_CONNECTION_CONFIG' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
