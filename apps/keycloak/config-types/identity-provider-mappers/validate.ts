import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readKeyValueMap, readString } from '../../lib/fields'

/**
 * Validate identity-provider-mapper items: a non-empty alias, a non-empty
 * mapper name with no whitespace, and a required identityProviderMapper type
 * id. Static (no target access — the referenced identity provider's existence
 * is checked at deploy time). The identity is the COMPOSITE (alias, name): the
 * same mapper name may legitimately exist on two different identity providers.
 * An empty config is warned about because most mapper types need at least some
 * config to do anything useful.
 */
const NAME_RE = /^[^\s]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one identity provider mapper.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const alias = readString(item.fields.alias)
    const name = readString(item.fields.name)
    const identityProviderMapper = readString(item.fields.identityProviderMapper)

    if (!alias) {
      errors.push({
        field: `items[${i}].alias`,
        message: 'Identity provider alias is required.',
        code: 'EMPTY_ALIAS',
      })
    }

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Mapper name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Mapper name "${name}" must not contain whitespace.`,
        code: 'INVALID_NAME',
      })
    }

    if (!identityProviderMapper) {
      errors.push({
        field: `items[${i}].identityProviderMapper`,
        message: 'Mapper type is required.',
        code: 'EMPTY_IDENTITY_PROVIDER_MAPPER',
      })
    }

    if (alias && name) {
      const key = `${alias}::${name}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Mapper "${name}" on identity provider "${alias}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_MAPPER',
        })
      } else {
        seen.add(key)
      }
    }

    const config = readKeyValueMap(item.fields.config)
    if (Object.keys(config).length === 0) {
      warnings.push({
        field: `items[${i}].config`,
        message: 'No mapper config set — most identity-provider mappers need at least some config to do anything useful.',
        code: 'EMPTY_CONFIG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
