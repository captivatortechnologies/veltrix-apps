import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readKeyValueMap, readOptionalInt } from '../../lib/fields'
import { TENANT_FLAG_KEYS } from './_shared'

/**
 * Validate the Auth0 Tenant Settings singleton: at most one declared item,
 * every `flags` key in the documented allowlist with a literal "true"/"false"
 * string value, and a positive `session_lifetime` / `idle_session_lifetime`
 * when the operator supplied one (Auth0 rejects 0). Static: no target access
 * required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the Tenant Settings item.', code: 'EMPTY' })
  }
  if (items.length > 1) {
    errors.push({ field: 'items', message: 'Tenant Settings is a singleton — declare it only once per canvas', code: 'singleton' })
  }

  items.forEach((item, i) => {
    for (const [key, value] of Object.entries(readKeyValueMap(item.fields.flags))) {
      if (!TENANT_FLAG_KEYS.has(key)) {
        errors.push({
          field: `items[${i}].flags`,
          message: `Flag "${key}" is not one of the supported tenant flags (${[...TENANT_FLAG_KEYS].join(', ')}).`,
          code: 'UNKNOWN_FLAG',
        })
        continue
      }
      if (value !== 'true' && value !== 'false') {
        errors.push({
          field: `items[${i}].flags`,
          message: `Flag "${key}" must be the literal string "true" or "false" (got "${value}").`,
          code: 'INVALID_FLAG_VALUE',
        })
      }
    }

    const rawSession = item.fields.session_lifetime
    if (rawSession !== undefined && rawSession !== null && rawSession !== '') {
      const n = readOptionalInt(rawSession)
      if (n === undefined || n <= 0) {
        errors.push({
          field: `items[${i}].session_lifetime`,
          message: `Session lifetime must be a positive number of hours (got "${String(rawSession)}").`,
          code: 'INVALID_SESSION_LIFETIME',
        })
      }
    }

    const rawIdle = item.fields.idle_session_lifetime
    if (rawIdle !== undefined && rawIdle !== null && rawIdle !== '') {
      const n = readOptionalInt(rawIdle)
      if (n === undefined || n <= 0) {
        errors.push({
          field: `items[${i}].idle_session_lifetime`,
          message: `Idle session lifetime must be a positive number of hours (got "${String(rawIdle)}").`,
          code: 'INVALID_IDLE_SESSION_LIFETIME',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
