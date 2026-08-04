import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { YES_NO } from './_shared'

const TYPE_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * Validate galaxy items: a non-empty name, a lowercase-kebab type, a known
 * enabled value, and (when provided) valid JSON kill-chain order. Static — no
 * target access required. `type` doubles as the galaxy identity, so a
 * duplicate type is flagged (last one wins) — MISP does not enforce type
 * uniqueness at the database level.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one galaxy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const enabled = String(item.fields.enabled ?? '').trim()
    const killChainOrder = String(item.fields.kill_chain_order ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Galaxy name is required.', code: 'EMPTY_NAME' })
    }

    if (!type) {
      errors.push({ field: `items[${i}].type`, message: 'Galaxy type is required.', code: 'EMPTY_TYPE' })
    } else if (!TYPE_PATTERN.test(type)) {
      errors.push({ field: `items[${i}].type`, message: `Type must be lowercase alphanumeric with hyphens, e.g. internal-threat-actor (got "${type}").`, code: 'INVALID_TYPE' })
    } else if (seen.has(type.toLowerCase())) {
      warnings.push({ field: `items[${i}].type`, message: `Galaxy type "${type}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TYPE' })
    } else {
      seen.add(type.toLowerCase())
    }

    if (!YES_NO.has(enabled)) {
      errors.push({ field: `items[${i}].enabled`, message: `Enabled must be yes or no (got "${enabled}").`, code: 'INVALID_ENABLED' })
    }

    if (killChainOrder) {
      try {
        JSON.parse(killChainOrder)
      } catch {
        errors.push({ field: `items[${i}].kill_chain_order`, message: 'Kill Chain Order must be valid JSON.', code: 'INVALID_JSON' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
