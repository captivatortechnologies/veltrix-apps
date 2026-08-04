import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'
import { FLOW_PROVIDER_IDS } from './_shared'

/**
 * Validate authentication-flow items: a non-empty alias — unlike most identities in
 * this app, Keycloak flow aliases commonly contain spaces (e.g. "My Custom Browser
 * Flow"), so no whitespace pattern is enforced, just a non-blank trimmed string —
 * and a providerId from the closed basic-flow/client-flow set. Static (no target
 * access). The alias is the identity, so a duplicate is flagged.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one authentication flow.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const alias = readString(item.fields.alias)
    const providerId = readString(item.fields.providerId)

    if (!alias) {
      errors.push({ field: `items[${i}].alias`, message: 'Flow alias is required.', code: 'EMPTY_ALIAS' })
    } else if (seen.has(alias)) {
      warnings.push({
        field: `items[${i}].alias`,
        message: `Flow alias ${alias} is listed more than once; the last one wins.`,
        code: 'DUPLICATE_ALIAS',
      })
    } else {
      seen.add(alias)
    }

    if (!providerId) {
      errors.push({
        field: `items[${i}].providerId`,
        message: 'Provider type is required.',
        code: 'EMPTY_PROVIDER_ID',
      })
    } else if (!FLOW_PROVIDER_IDS.has(providerId)) {
      errors.push({
        field: `items[${i}].providerId`,
        message: `Provider type "${providerId}" must be one of: ${[...FLOW_PROVIDER_IDS].join(', ')}.`,
        code: 'INVALID_PROVIDER_ID',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
