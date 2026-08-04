import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { trimStr } from '../../lib/tableRecords'
import { TABLE_RE } from './_shared'

/**
 * Validate assignment-rule items. Static — no target access required:
 *   - a non-empty name and table
 * Identity is (name, table); a duplicate pair is flagged (last one wins). A
 * rule with no group, user or script does nothing (warning).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one assignment rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = trimStr(item.fields.name)
    const table = trimStr(item.fields.table)
    const group = trimStr(item.fields.group)
    const user = trimStr(item.fields.user)
    const script = trimStr(item.fields.script)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    }

    if (!table) {
      errors.push({ field: `items[${i}].table`, message: 'Table is required.', code: 'EMPTY_TABLE' })
    } else if (!TABLE_RE.test(table)) {
      errors.push({
        field: `items[${i}].table`,
        message: `Table "${table}" must be an internal table name (lowercase letters, digits and underscores).`,
        code: 'INVALID_TABLE',
      })
    }

    if (!group && !user && !script) {
      warnings.push({
        field: `items[${i}].group`,
        message: `Rule "${name || '(unnamed)'}" sets no group, user or script — it will never assign anything.`,
        code: 'NO_ASSIGNMENT_TARGET',
      })
    }

    if (name && table) {
      const key = `${name} ${table}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Assignment rule "${name}" on table "${table}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_IDENTITY',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
