import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MATCHING_TYPES, STREAM_RULE_TYPES, VALUELESS_RULE_TYPES, parseRules } from './_shared'

/**
 * Validate stream items: a non-empty title (the identity, so a duplicate is
 * flagged — last one wins), a valid matching type (AND/OR), and — when a rules
 * JSON is provided — a well-formed array of rules with a field, a known type
 * integer, and a value where the type needs one. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one stream.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const title = String(item.fields.title ?? '').trim()
    const matchingType = String(item.fields.matching_type ?? '').trim().toUpperCase()

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Stream title is required.', code: 'EMPTY_TITLE' })
    } else if (seen.has(title)) {
      warnings.push({ field: `items[${i}].title`, message: `Stream title "${title}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TITLE' })
    } else {
      seen.add(title)
    }

    if (!MATCHING_TYPES.has(matchingType)) {
      errors.push({ field: `items[${i}].matching_type`, message: `Matching type must be AND or OR (got "${matchingType}").`, code: 'INVALID_MATCHING_TYPE' })
    }

    const { rules, error } = parseRules(item.fields.rules)
    if (error) {
      errors.push({ field: `items[${i}].rules`, message: error, code: 'INVALID_RULES_JSON' })
      return
    }

    rules.forEach((rule, r) => {
      const field = `items[${i}].rules[${r}]`
      if (!rule.field || !String(rule.field).trim()) {
        errors.push({ field: `${field}.field`, message: 'Each rule needs a "field".', code: 'RULE_MISSING_FIELD' })
      }
      if (rule.type == null || Number.isNaN(rule.type) || !(rule.type in STREAM_RULE_TYPES)) {
        errors.push({
          field: `${field}.type`,
          message: `Rule "type" must be one of ${Object.keys(STREAM_RULE_TYPES).join(', ')} (got "${rule.type}").`,
          code: 'RULE_INVALID_TYPE',
        })
      } else if (!VALUELESS_RULE_TYPES.has(rule.type) && (rule.value == null || rule.value === '')) {
        errors.push({
          field: `${field}.value`,
          message: `Rule type ${rule.type} (${STREAM_RULE_TYPES[rule.type]}) requires a "value".`,
          code: 'RULE_MISSING_VALUE',
        })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
