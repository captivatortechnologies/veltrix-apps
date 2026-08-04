import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readBool } from '../../lib/fields'
import { NUMBER_FIELDS } from './_shared'

/**
 * Validate the realm-settings singleton: exactly one item is declared; every
 * Tokens field, when provided, is a non-negative integer (seconds — Keycloak's
 * wire format, not a duration string); and loginWithEmailAllowed +
 * duplicateEmailsAllowed may not both be true — cited directly from the
 * official keycloak_realm Terraform resource documentation, since Keycloak
 * cannot resolve which account to log in to by email when both hold. Static —
 * no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({
      field: 'items',
      message: 'Realm Settings has no configuration — add the singleton item.',
      code: 'EMPTY',
    })
    return { valid: false, errors, warnings }
  }
  if (items.length > 1) {
    errors.push({
      field: 'items',
      message: 'Realm Settings is a realm-wide singleton — declare exactly one item.',
      code: 'MULTIPLE_ITEMS',
    })
  }

  items.forEach((item, i) => {
    for (const key of NUMBER_FIELDS) {
      const raw = item.fields[key]
      if (raw === undefined || raw === null || raw === '') continue
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isInteger(n) || n < 0) {
        errors.push({
          field: `items[${i}].${key}`,
          message: `${key} must be a non-negative integer number of seconds, got "${raw}".`,
          code: 'INVALID_NUMBER_FIELD',
        })
      }
    }

    const loginWithEmailAllowed = readBool(item.fields.loginWithEmailAllowed, true)
    const duplicateEmailsAllowed = readBool(item.fields.duplicateEmailsAllowed, false)
    if (loginWithEmailAllowed && duplicateEmailsAllowed) {
      errors.push({
        field: `items[${i}].duplicateEmailsAllowed`,
        message: 'duplicateEmailsAllowed must be false whenever loginWithEmailAllowed is true.',
        code: 'DUPLICATE_EMAILS_WITH_LOGIN_BY_EMAIL',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
