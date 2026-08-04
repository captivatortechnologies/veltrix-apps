import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseMetadataEntries } from './_shared'

const MAX_KEY_LENGTH = 128
const MAX_VALUE_LENGTH = 4096

/**
 * Validate the server-metadata singleton: a scope (identity) and, optionally, a
 * set of key/value tags. Static — no target access required. More than one item
 * is flagged (this is a singleton; the first one wins). An empty metadata map is
 * valid (nothing to declare) but warned, since it makes the config a no-op.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the server metadata configuration.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }
  if (items.length > 1) {
    warnings.push({ field: 'items', message: 'Server metadata is a singleton; only the first item is applied.', code: 'SINGLETON' })
  }

  const item = items[0]
  const scope = String(item.fields.scope ?? '').trim()
  const entries = parseMetadataEntries(item.fields.metadata)

  if (!scope) {
    errors.push({ field: 'items[0].scope', message: 'Scope is required (leave as "server").', code: 'EMPTY_SCOPE' })
  }
  if (entries.length === 0) {
    warnings.push({ field: 'items[0].metadata', message: 'No metadata keys declared — this configuration is a no-op.', code: 'EMPTY_METADATA' })
  }

  for (const { key, value } of entries) {
    if (key.length > MAX_KEY_LENGTH) {
      errors.push({
        field: 'items[0].metadata',
        message: `Metadata key "${key.slice(0, 40)}…" exceeds ${MAX_KEY_LENGTH} characters.`,
        code: 'KEY_TOO_LONG',
      })
    }
    if (value.length > MAX_VALUE_LENGTH) {
      errors.push({
        field: 'items[0].metadata',
        message: `Metadata value for key "${key}" exceeds ${MAX_VALUE_LENGTH} characters.`,
        code: 'VALUE_TOO_LONG',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
