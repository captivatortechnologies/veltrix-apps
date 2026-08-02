import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate scan-task items: a non-empty name plus a target, scan config and
 * scanner reference. Static — the actual foreign keys (does a target/config/
 * scanner with that name exist?) are resolved against the live gvmd at deploy
 * time, since that requires a socket. Task names double as the upsert identity,
 * so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one scan task.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const target = String(item.fields.target ?? '').trim()
    const config = String(item.fields.config ?? '').trim()
    const scanner = String(item.fields.scanner ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Task name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Task name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!target) {
      errors.push({ field: `items[${i}].target`, message: 'A target (by name, or its UUID) is required.', code: 'EMPTY_TARGET' })
    }
    if (!config) {
      errors.push({ field: `items[${i}].config`, message: 'A scan config (by name, e.g. "Full and fast", or its UUID) is required.', code: 'EMPTY_CONFIG' })
    }
    if (!scanner) {
      errors.push({ field: `items[${i}].scanner`, message: 'A scanner (by name, e.g. "OpenVAS Default", or its UUID) is required.', code: 'EMPTY_SCANNER' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
