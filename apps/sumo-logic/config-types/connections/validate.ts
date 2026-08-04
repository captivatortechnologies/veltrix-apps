import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { toHeaderList } from './_shared'

const VALID_TYPES = new Set(['WebhookDefinition', 'ServiceNowDefinition'])

/**
 * Validate connection items: a non-empty name, a valid kind, and the fields
 * that kind requires (Webhook needs url + defaultPayload; ServiceNow needs
 * url + username + password). Static — no target access required. The name is
 * the identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one connection.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const url = String(item.fields.url ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Connection name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Connection name "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!VALID_TYPES.has(type)) {
      errors.push({ field: `items[${i}].type`, message: 'Kind must be WebhookDefinition or ServiceNowDefinition.', code: 'INVALID_TYPE' })
      return
    }

    if (!url) {
      errors.push({ field: `items[${i}].url`, message: 'URL is required.', code: 'EMPTY_URL' })
    }

    if (type === 'ServiceNowDefinition') {
      if (!String(item.fields.username ?? '').trim()) {
        errors.push({ field: `items[${i}].username`, message: 'Username is required for ServiceNow connections.', code: 'EMPTY_USERNAME' })
      }
      if (!String(item.fields.password ?? '').trim()) {
        errors.push({ field: `items[${i}].password`, message: 'Password is required for ServiceNow connections.', code: 'EMPTY_PASSWORD' })
      }
    } else {
      if (!String(item.fields.defaultPayload ?? '').trim()) {
        errors.push({ field: `items[${i}].defaultPayload`, message: 'Default payload is required for Webhook connections.', code: 'EMPTY_DEFAULT_PAYLOAD' })
      }
      const customHeaders = toHeaderList(item.fields.customHeaders)
      if (customHeaders.length > 5) {
        errors.push({ field: `items[${i}].customHeaders`, message: 'Custom headers are limited to 5 entries.', code: 'TOO_MANY_CUSTOM_HEADERS' })
      }
      if (toHeaderList(item.fields.headers).length > 0) {
        warnings.push({
          field: `items[${i}].headers`,
          message: `Connection "${name || i}" declares authorization headers — Sumo Logic masks these on read, so rollback cannot restore a changed value.`,
          code: 'HEADERS_NOT_RESTORABLE',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
