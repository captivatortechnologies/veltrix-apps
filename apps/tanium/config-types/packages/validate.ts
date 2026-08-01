import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseNonNegativeInt } from './_shared'

/**
 * Validate package items: a non-empty name and command, plus non-negative integer
 * timeout/expiry when supplied. Static — no target access required. The name is
 * the group identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one package.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const command = String(item.fields.command ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Package name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({ field: `items[${i}].name`, message: `Package name ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name.toLowerCase())
    }

    if (!command) {
      errors.push({ field: `items[${i}].command`, message: 'Package command is required.', code: 'EMPTY_COMMAND' })
    }

    const timeout = parseNonNegativeInt(item.fields.commandTimeout)
    if (timeout.error) {
      errors.push({ field: `items[${i}].commandTimeout`, message: `Command timeout ${timeout.error}.`, code: 'INVALID_TIMEOUT' })
    }
    const expire = parseNonNegativeInt(item.fields.expireSeconds)
    if (expire.error) {
      errors.push({ field: `items[${i}].expireSeconds`, message: `Expire ${expire.error}.`, code: 'INVALID_EXPIRE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
