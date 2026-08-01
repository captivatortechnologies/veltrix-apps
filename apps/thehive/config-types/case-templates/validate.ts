import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  SEVERITY_MIN,
  SEVERITY_MAX,
  TLP_MIN,
  TLP_MAX,
  PAP_MIN,
  PAP_MAX,
} from './_shared'

/**
 * Validate case-template items: a non-empty name and in-range severity / TLP /
 * PAP. Static — no target access required. The template name is the stable
 * identity, so a duplicate name is flagged (last one wins).
 */
function inRange(value: unknown, min: number, max: number): boolean {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10)
  return Number.isInteger(n) && n >= min && n <= max
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one case template.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Template name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Template name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!inRange(item.fields.severity, SEVERITY_MIN, SEVERITY_MAX)) {
      errors.push({ field: `items[${i}].severity`, message: `Severity must be ${SEVERITY_MIN}–${SEVERITY_MAX}.`, code: 'INVALID_SEVERITY' })
    }
    if (!inRange(item.fields.tlp, TLP_MIN, TLP_MAX)) {
      errors.push({ field: `items[${i}].tlp`, message: `TLP must be ${TLP_MIN}–${TLP_MAX}.`, code: 'INVALID_TLP' })
    }
    if (!inRange(item.fields.pap, PAP_MIN, PAP_MAX)) {
      errors.push({ field: `items[${i}].pap`, message: `PAP must be ${PAP_MIN}–${PAP_MAX}.`, code: 'INVALID_PAP' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
