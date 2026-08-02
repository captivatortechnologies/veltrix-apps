import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString } from '../../lib/coerce'
import { extractRuleName } from './_shared'

/**
 * Validate pipeline-rule items: a non-empty title (the identity — a duplicate is
 * flagged, last one wins), a non-empty DSL source, and — critically — a title that
 * matches the `rule "NAME"` in the source. Graylog derives the stored rule title
 * from the parsed source, so a mismatch would make our upsert-by-title and drift
 * detection point at the wrong (or a non-existent) rule. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one pipeline rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const title = asString(item.fields.title)
    const source = String(item.fields.source ?? '').trim()

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Rule title is required.', code: 'EMPTY_TITLE' })
    } else if (seen.has(title)) {
      warnings.push({ field: `items[${i}].title`, message: `Rule title "${title}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TITLE' })
    } else {
      seen.add(title)
    }

    if (!source) {
      errors.push({ field: `items[${i}].source`, message: 'Rule source (the rule DSL) is required.', code: 'EMPTY_SOURCE' })
      return
    }

    const ruleName = extractRuleName(source)
    if (!ruleName) {
      errors.push({ field: `items[${i}].source`, message: 'Rule source must declare a rule, e.g. rule "my-rule" ... end.', code: 'NO_RULE_NAME' })
    } else if (title && ruleName !== title) {
      errors.push({
        field: `items[${i}].title`,
        message: `Title "${title}" must match the rule name in the source ("${ruleName}") — Graylog names the rule from its DSL.`,
        code: 'RULE_NAME_MISMATCH',
      })
    }

    for (const kw of ['when', 'then', 'end']) {
      if (!new RegExp(`\\b${kw}\\b`).test(source)) {
        warnings.push({ field: `items[${i}].source`, message: `Rule source is missing the "${kw}" keyword — a rule reads: rule "..." when ... then ... end.`, code: 'MISSING_KEYWORD' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
