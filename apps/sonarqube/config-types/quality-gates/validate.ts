import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseConditions, dedupeByMetric } from './_shared'

/**
 * Validate quality-gate items: a non-empty name and at least one well-formed
 * condition (`<metric> <LT|GT> <threshold>`). Static — no target access required.
 * The gate name doubles as the gate identity, so a duplicate name is flagged
 * (last one wins). More than one gate flagged default is a warning (SonarQube has a
 * single default; the last applied wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one quality gate.', code: 'EMPTY' })
  }

  const seenNames = new Set<string>()
  let defaultCount = 0

  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Quality gate name is required.', code: 'EMPTY_NAME' })
    } else if (seenNames.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Quality gate "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seenNames.add(name)
    }

    const { conditions, errors: parseErrors } = parseConditions(item.fields.conditions)
    for (const pe of parseErrors) {
      errors.push({ field: `items[${i}].conditions`, message: `Line ${pe.line}: ${pe.message}`, code: pe.code })
    }
    if (conditions.length === 0 && parseErrors.length === 0) {
      errors.push({ field: `items[${i}].conditions`, message: 'Add at least one condition (e.g. new_coverage LT 80).', code: 'NO_CONDITIONS' })
    }

    const { duplicates } = dedupeByMetric(conditions)
    for (const metric of duplicates) {
      warnings.push({ field: `items[${i}].conditions`, message: `Metric "${metric}" has more than one condition; SonarQube allows one per metric, so the last one wins.`, code: 'DUPLICATE_METRIC' })
    }

    if (normalizeDefault(item.fields.isDefault)) defaultCount++
  })

  if (defaultCount > 1) {
    warnings.push({ field: 'items', message: `${defaultCount} gates are flagged as default; SonarQube keeps a single default, so the last one applied wins.`, code: 'MULTIPLE_DEFAULT' })
  }

  return { valid: errors.length === 0, errors, warnings }
}

function normalizeDefault(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}
