import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'
import { readOptionalInt, WELL_KNOWN_REQUIRED_ACTIONS } from './_shared'

/**
 * Validate required-action items: a non-empty alias and name, and a non-negative
 * integer priority when one is provided. Static (no target access). An alias
 * outside Keycloak's well-known built-ins is WARNED, not errored — custom
 * SPI-registered providers can legitimately add more (same posture as
 * identity-providers/validate.ts's UNKNOWN_PROVIDER_ID warning). The alias is the
 * identity, so a duplicate is flagged.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one required action.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const alias = readString(item.fields.alias)
    const name = readString(item.fields.name)

    if (!alias) {
      errors.push({ field: `items[${i}].alias`, message: 'Alias is required.', code: 'EMPTY_ALIAS' })
    } else if (seen.has(alias)) {
      warnings.push({
        field: `items[${i}].alias`,
        message: `Alias ${alias} is listed more than once; the last one wins.`,
        code: 'DUPLICATE_ALIAS',
      })
    } else {
      seen.add(alias)
    }

    if (alias && !WELL_KNOWN_REQUIRED_ACTIONS.has(alias)) {
      warnings.push({
        field: `items[${i}].alias`,
        message: `Alias "${alias}" is not one of Keycloak's well-known built-in required actions — make sure a matching provider is registered on this server.`,
        code: 'UNKNOWN_REQUIRED_ACTION',
      })
    }

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Display name is required.', code: 'EMPTY_NAME' })
    }

    const rawPriority = item.fields.priority
    if (rawPriority !== undefined && rawPriority !== null && rawPriority !== '') {
      const n = readOptionalInt(rawPriority)
      if (n === undefined || n < 0) {
        errors.push({
          field: `items[${i}].priority`,
          message: 'Priority must be a non-negative integer.',
          code: 'INVALID_PRIORITY',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
