import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { PRIORITIES, SOURCES, normalizePriority } from './_shared'

/**
 * Validate Falco-rule items: a non-empty unique name, a non-empty condition and
 * output, a known priority and a known source. Static — no target access
 * required. The rule name is the stable identity, so a duplicate name is flagged
 * (last one wins on deploy).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Falco rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const condition = String(item.fields.condition ?? '').trim()
    const output = String(item.fields.output ?? '').trim()
    const priority = normalizePriority(item.fields.priority)
    const source = String(item.fields.source ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Rule name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Rule name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!condition) {
      errors.push({ field: `items[${i}].condition`, message: 'Falco condition expression is required.', code: 'EMPTY_CONDITION' })
    }

    if (!output) {
      errors.push({ field: `items[${i}].output`, message: 'Alert output is required.', code: 'EMPTY_OUTPUT' })
    }

    if (!PRIORITIES.has(priority)) {
      errors.push({
        field: `items[${i}].priority`,
        message: `Priority must be one of ${[...PRIORITIES].join(', ')} (got "${priority}").`,
        code: 'INVALID_PRIORITY',
      })
    }

    if (!SOURCES.has(source)) {
      errors.push({
        field: `items[${i}].source`,
        message: `Source must be one of ${[...SOURCES].join(', ')} (got "${source}").`,
        code: 'INVALID_SOURCE',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
