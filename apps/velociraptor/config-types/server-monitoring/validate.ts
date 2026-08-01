import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'

/**
 * Validate the server-monitoring singleton: a scope (identity) and, when enabled,
 * at least one server event artifact. Static — no target access required. More
 * than one item is flagged (this is a singleton; the first one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the server monitoring configuration.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }
  if (items.length > 1) {
    warnings.push({ field: 'items', message: 'Server monitoring is a singleton; only the first item is applied.', code: 'SINGLETON' })
  }

  const item = items[0]
  const scope = String(item.fields.scope ?? '').trim()
  const enabled = asBool(item.fields.enabled, true)
  const artifacts = splitList(item.fields.artifacts)

  if (!scope) {
    errors.push({ field: 'items[0].scope', message: 'Scope is required (leave as "server").', code: 'EMPTY_SCOPE' })
  }
  if (enabled && artifacts.length === 0) {
    errors.push({ field: 'items[0].artifacts', message: 'Enabled server monitoring needs at least one server event artifact.', code: 'EMPTY_ARTIFACTS' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
