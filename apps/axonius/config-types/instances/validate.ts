import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseText } from './_shared'

/**
 * Validate instance items: a non-empty node_id (the identity of an EXISTING
 * instance — never verified live here, only at deploy time) and a non-empty
 * display name. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one instance.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const nodeId = parseText(item.fields.node_id)
    const nodeName = parseText(item.fields.node_name)

    if (!nodeId) {
      errors.push({ field: `items[${i}].node_id`, message: 'Node ID is required.', code: 'EMPTY_NODE_ID' })
    }

    if (!nodeName) {
      errors.push({ field: `items[${i}].node_name`, message: 'Display name is required.', code: 'EMPTY_NODE_NAME' })
    }

    if (nodeId) {
      if (seen.has(nodeId)) {
        warnings.push({ field: `items[${i}].node_id`, message: `Node "${nodeId}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NODE_ID' })
      } else {
        seen.add(nodeId)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
