import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonField } from '../../lib/reconcile'
import { CATEGORIES, MIN_SCORE, MAX_SCORE, PRIORITIES, type ComplianceFrameworkRef } from './_shared'

/**
 * Validate discovery-alert items: a non-empty name, a known category, a score
 * in range, a Discovery query that parses as a JSON object and — when given —
 * a compliance-frameworks array that parses as { name, section, priority }[]
 * with a known priority. Static — no target access required. A duplicate name
 * is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one discovery alert.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const category = String(item.fields.category ?? '').trim()
    const rawScore = item.fields.orcaScore

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Alert name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Alert name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!CATEGORIES.has(category)) {
      errors.push({
        field: `items[${i}].category`,
        message: `Category must be one of the Orca alert categories (got "${category}").`,
        code: 'INVALID_CATEGORY',
      })
    }

    const score = typeof rawScore === 'number' ? rawScore : Number(String(rawScore ?? '').trim())
    if (rawScore === undefined || rawScore === null || rawScore === '' || !Number.isFinite(score)) {
      errors.push({ field: `items[${i}].orcaScore`, message: 'A numeric risk score is required.', code: 'EMPTY_SCORE' })
    } else if (score < MIN_SCORE || score > MAX_SCORE) {
      errors.push({
        field: `items[${i}].orcaScore`,
        message: `Risk score must be between ${MIN_SCORE} and ${MAX_SCORE} (got ${score}).`,
        code: 'INVALID_SCORE',
      })
    }

    const ruleJson = parseJsonField(item.fields.ruleJson, 'Discovery query')
    if (!ruleJson.ok) {
      errors.push({ field: `items[${i}].ruleJson`, message: ruleJson.error, code: 'INVALID_RULE_JSON' })
    } else if (!ruleJson.value || typeof ruleJson.value !== 'object' || Array.isArray(ruleJson.value)) {
      errors.push({ field: `items[${i}].ruleJson`, message: 'Discovery query must be a JSON object.', code: 'INVALID_RULE_JSON' })
    }

    const rawFrameworks = typeof item.fields.complianceFrameworks === 'string' ? item.fields.complianceFrameworks.trim() : ''
    if (rawFrameworks) {
      const frameworks = parseJsonField<ComplianceFrameworkRef[]>(item.fields.complianceFrameworks, 'Compliance frameworks')
      if (!frameworks.ok) {
        errors.push({ field: `items[${i}].complianceFrameworks`, message: frameworks.error, code: 'INVALID_COMPLIANCE_FRAMEWORKS' })
      } else if (!Array.isArray(frameworks.value)) {
        errors.push({ field: `items[${i}].complianceFrameworks`, message: 'Compliance frameworks must be a JSON array.', code: 'INVALID_COMPLIANCE_FRAMEWORKS' })
      } else {
        frameworks.value.forEach((ref, fi) => {
          if (!ref || typeof ref !== 'object' || !ref.name || !ref.section || !ref.priority) {
            errors.push({
              field: `items[${i}].complianceFrameworks[${fi}]`,
              message: 'Each compliance framework needs name, section and priority.',
              code: 'INVALID_COMPLIANCE_FRAMEWORKS',
            })
          } else if (!PRIORITIES.has(ref.priority)) {
            errors.push({
              field: `items[${i}].complianceFrameworks[${fi}].priority`,
              message: `Priority must be one of high, medium, low (got "${ref.priority}").`,
              code: 'INVALID_PRIORITY',
            })
          }
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
