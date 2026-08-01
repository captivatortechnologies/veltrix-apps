import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readKeyValueMap, readString } from '../../lib/fields'
import { PROVIDER_IDS } from './_shared'

/**
 * Validate identity-provider items: a non-empty alias with no whitespace and a
 * known providerId. Static (no target access). The alias is the identity AND the
 * {alias} path segment, so a duplicate is flagged. An empty config is warned about
 * because most providers need at least endpoints/clientId to function.
 */
const ALIAS_RE = /^[^\s]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one identity provider.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const alias = readString(item.fields.alias)
    const providerId = readString(item.fields.providerId)

    if (!alias) {
      errors.push({ field: `items[${i}].alias`, message: 'Alias is required.', code: 'EMPTY_ALIAS' })
    } else if (!ALIAS_RE.test(alias)) {
      errors.push({
        field: `items[${i}].alias`,
        message: `Alias "${alias}" must not contain whitespace.`,
        code: 'INVALID_ALIAS',
      })
    } else if (seen.has(alias)) {
      warnings.push({
        field: `items[${i}].alias`,
        message: `Alias ${alias} is listed more than once; the last one wins.`,
        code: 'DUPLICATE_ALIAS',
      })
    } else {
      seen.add(alias)
    }

    if (!providerId) {
      errors.push({ field: `items[${i}].providerId`, message: 'Provider type is required.', code: 'EMPTY_PROVIDER_ID' })
    } else if (!PROVIDER_IDS.has(providerId)) {
      warnings.push({
        field: `items[${i}].providerId`,
        message: `Provider type "${providerId}" is not one of the known built-ins — make sure the provider is installed in Keycloak.`,
        code: 'UNKNOWN_PROVIDER_ID',
      })
    }

    const config = readKeyValueMap(item.fields.config)
    if (Object.keys(config).length === 0) {
      warnings.push({
        field: `items[${i}].config`,
        message: 'No provider config set — most providers need at least endpoints and a clientId to work.',
        code: 'EMPTY_CONFIG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
