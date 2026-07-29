import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate detection rule items: a safe rule_id, a non-empty name and query, a
 * known severity and an in-range risk score. Static — no target access required.
 * riskScore may arrive as number or string; coerce first.
 */
const RULE_ID_RE = /^[a-zA-Z0-9._:-]+$/
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one detection rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const ruleId = String(item.fields.ruleId ?? '').trim()
    const name = String(item.fields.name ?? '').trim()
    const severity = String(item.fields.severity ?? '').trim()
    const query = String(item.fields.query ?? '').trim()
    const riskScore = Number(item.fields.riskScore)

    if (!ruleId) {
      errors.push({ field: `items[${i}].ruleId`, message: 'Rule ID is required.', code: 'EMPTY_RULE_ID' })
    } else if (!RULE_ID_RE.test(ruleId)) {
      errors.push({ field: `items[${i}].ruleId`, message: `Rule ID "${ruleId}" may only contain letters, numbers, dot, underscore, colon or hyphen.`, code: 'INVALID_RULE_ID' })
    } else if (seen.has(ruleId)) {
      warnings.push({ field: `items[${i}].ruleId`, message: `Rule ID ${ruleId} is listed more than once; the last one wins.`, code: 'DUPLICATE_RULE_ID' })
    } else {
      seen.add(ruleId)
    }

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Rule name is required.', code: 'EMPTY_NAME' })
    }

    if (!SEVERITIES.has(severity)) {
      errors.push({ field: `items[${i}].severity`, message: `Severity must be one of low, medium, high, critical (got "${severity}").`, code: 'INVALID_SEVERITY' })
    }

    if (!Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) {
      errors.push({ field: `items[${i}].riskScore`, message: 'Risk score must be a number between 0 and 100.', code: 'INVALID_RISK_SCORE' })
    }

    if (!query) {
      errors.push({ field: `items[${i}].query`, message: 'Query is required.', code: 'EMPTY_QUERY' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
