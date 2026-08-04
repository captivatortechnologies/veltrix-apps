import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readKeyValueMap } from '../../lib/reconcile'
import { RULE_TYPES } from './_shared'

/**
 * Validate custom-tag-rule items: a non-empty name (the identity), a known
 * rule type, a non-empty query and at least one tag. When rule type is "json"
 * the query must parse as JSON. Static — no target access required. A
 * duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom tag rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const ruleType = String(item.fields.ruleType ?? 'string').trim() || 'string'
    const rule = String(item.fields.rule ?? '').trim()
    const tags = readKeyValueMap(item.fields.tags)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Rule name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Rule name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!RULE_TYPES.has(ruleType)) {
      errors.push({ field: `items[${i}].ruleType`, message: `Rule type must be "string" or "json" (got "${ruleType}").`, code: 'INVALID_RULE_TYPE' })
    }

    if (!rule) {
      errors.push({ field: `items[${i}].rule`, message: 'A query is required.', code: 'EMPTY_RULE' })
    } else if (ruleType === 'json') {
      try {
        JSON.parse(rule)
      } catch (e) {
        errors.push({
          field: `items[${i}].rule`,
          message: `Query is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}`,
          code: 'INVALID_RULE_JSON',
        })
      }
    }

    if (Object.keys(tags).length === 0) {
      errors.push({ field: `items[${i}].tags`, message: 'At least one tag key/value pair is required.', code: 'EMPTY_TAGS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
