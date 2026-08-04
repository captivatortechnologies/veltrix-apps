import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonObject, readString } from '../../lib/fields'
import { EMAIL_PROVIDER_NAMES } from './_shared'

/**
 * Validate the Auth0 Email Provider singleton: at most one declared item, a
 * known provider name, a non-empty default_from_address, and well-formed,
 * non-empty JSON credentials (Auth0 expects credentials on every write). When
 * present, `settings` must also be well-formed JSON. Static: no target access
 * required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the Email Provider item.', code: 'EMPTY' })
  }
  if (items.length > 1) {
    errors.push({ field: 'items', message: 'Email Provider is a singleton — declare it only once per canvas', code: 'singleton' })
  }

  items.forEach((item, i) => {
    const name = readString(item.fields.name)
    if (!EMAIL_PROVIDER_NAMES.has(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Email provider "${name}" is not one of the supported providers (${[...EMAIL_PROVIDER_NAMES].join(', ')}).`,
        code: 'INVALID_PROVIDER',
      })
    }

    if (!readString(item.fields.default_from_address)) {
      errors.push({ field: `items[${i}].default_from_address`, message: 'Default from address is required.', code: 'EMPTY_FROM_ADDRESS' })
    }

    const credentials = parseJsonObject(item.fields.credentials)
    if (!credentials.ok) {
      errors.push({ field: `items[${i}].credentials`, message: `Credentials ${credentials.error}.`, code: 'INVALID_CREDENTIALS' })
    } else if (Object.keys(credentials.value).length === 0) {
      errors.push({ field: `items[${i}].credentials`, message: 'Credentials are required to configure an email provider.', code: 'EMPTY_CREDENTIALS' })
    }

    const settings = parseJsonObject(item.fields.settings)
    if (!settings.ok) {
      errors.push({ field: `items[${i}].settings`, message: `Settings ${settings.error}.`, code: 'INVALID_SETTINGS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
