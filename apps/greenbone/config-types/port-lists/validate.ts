import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parsePortRange } from './_shared'

/**
 * Validate port-list items: a non-empty name and at least one valid TCP/UDP port
 * range token ("T:1-1024", "U:53"). Static — no gvmd access required. Port-list
 * names double as the upsert identity, so a duplicate name is flagged (last one
 * wins). FLAG: gvmd cannot change the ranges of an existing port list via
 * modify_port_list — a range edit needs a recreate (surfaced at deploy/drift).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one port list.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const rawRange = String(item.fields.portRange ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Port-list name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Port-list name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!rawRange) {
      errors.push({ field: `items[${i}].portRange`, message: 'At least one port range is required, e.g. "T:1-1024,U:53".', code: 'EMPTY_PORT_RANGE' })
      return
    }
    const { tokens, invalid } = parsePortRange(rawRange)
    if (invalid.length > 0) {
      errors.push({
        field: `items[${i}].portRange`,
        message: `Invalid port range token(s): ${invalid.join(', ')}. Use "T:" or "U:" with ports 1-65535, e.g. "T:1-1024,U:53".`,
        code: 'INVALID_PORT_RANGE',
      })
    }
    if (tokens.length === 0 && invalid.length === 0) {
      errors.push({ field: `items[${i}].portRange`, message: 'No valid port ranges parsed.', code: 'EMPTY_PORT_RANGE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
