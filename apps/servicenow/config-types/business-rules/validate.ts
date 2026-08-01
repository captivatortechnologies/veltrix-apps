import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { WHEN_VALUES, identityQuery, normalizeBool } from './_shared'

/**
 * Validate business-rule items. Static — no target access required:
 *   - a non-empty name and table (collection)
 *   - a valid `when` (before | after | async | display)
 *   - a table name that looks like a ServiceNow internal name
 *   - a non-empty script (this config type manages scripted rules)
 *   - at least one trigger (insert/update/delete/query) selected, else the rule
 *     never fires (warning)
 * Identity is (name, collection); a duplicate pair is flagged (last one wins).
 */
const TABLE_RE = /^[a-z][a-z0-9_]*$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one business rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const collection = String(item.fields.collection ?? '').trim()
    const when = String(item.fields.when ?? '').trim()
    const script = String(item.fields.script ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Rule name is required.', code: 'EMPTY_NAME' })
    }

    if (!collection) {
      errors.push({ field: `items[${i}].collection`, message: 'Table (collection) is required.', code: 'EMPTY_TABLE' })
    } else if (!TABLE_RE.test(collection)) {
      errors.push({
        field: `items[${i}].collection`,
        message: `Table "${collection}" must be an internal table name (lowercase letters, digits and underscores).`,
        code: 'INVALID_TABLE',
      })
    }

    if (!WHEN_VALUES.has(when)) {
      errors.push({
        field: `items[${i}].when`,
        message: `When must be one of before, after, async, display (got "${when}").`,
        code: 'INVALID_WHEN',
      })
    }

    if (!script) {
      errors.push({ field: `items[${i}].script`, message: 'Script is required for a business rule.', code: 'EMPTY_SCRIPT' })
    }

    const anyTrigger =
      normalizeBool(item.fields.actionInsert) ||
      normalizeBool(item.fields.actionUpdate) ||
      normalizeBool(item.fields.actionDelete) ||
      normalizeBool(item.fields.actionQuery)
    if (!anyTrigger) {
      warnings.push({
        field: `items[${i}].actionInsert`,
        message: `Rule "${name || '(unnamed)'}" has no trigger selected (insert/update/delete/query) — it will never fire.`,
        code: 'NO_TRIGGER',
      })
    }

    if (name && collection) {
      const key = identityQuery(name, collection)
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Rule "${name}" on table "${collection}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_IDENTITY',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
