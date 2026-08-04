import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'
import { validClientId } from '../../lib/clientId'

/**
 * Validate client-labels items: each needs a label (identity) and, when enabled,
 * at least one client id, and every client id (enabled or not — a disabled
 * label's list is kept authored so re-enabling restores it) must match
 * Velociraptor's "C.<hex>" client-id format. Static — no target access required.
 * The label is the reconcile identity, so a duplicate label is flagged (last one
 * wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one client label.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const label = String(item.fields.label ?? '').trim()
    const enabled = asBool(item.fields.enabled, true)
    const clientIds = splitList(item.fields.clientIds)

    if (!label) {
      errors.push({ field: `items[${i}].label`, message: 'Label is required.', code: 'EMPTY_LABEL' })
    } else {
      const key = label.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].label`, message: `Label "${label}" is listed more than once; the last one wins.`, code: 'DUPLICATE_LABEL' })
      } else {
        seen.add(key)
      }
    }

    if (enabled && clientIds.length === 0) {
      errors.push({
        field: `items[${i}].clientIds`,
        message: `Enabled label "${label || '(unnamed)'}" needs at least one client id.`,
        code: 'EMPTY_CLIENT_IDS',
      })
    }

    for (const clientId of clientIds) {
      if (!validClientId(clientId)) {
        errors.push({
          field: `items[${i}].clientIds`,
          message: `Client id "${clientId}" must match Velociraptor's format, e.g. C.1a2b3c4d5e6f7890.`,
          code: 'INVALID_CLIENT_ID',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
