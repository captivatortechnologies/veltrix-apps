import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { trimStr } from '../../lib/tableRecords'
import { TABLE_RE } from './_shared'

/**
 * Validate data-policy items. Static — no target access required:
 *   - a non-empty short description and table
 *   - a table name that looks like a ServiceNow internal name
 * Identity is (short_description, table); a duplicate pair is flagged (last
 * one wins). A policy with no condition still applies unconditionally, which
 * is valid, so it is not warned on (unlike UI Policies' on-load case — data
 * policies have no client-triggered equivalent).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one data policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const shortDescription = trimStr(item.fields.shortDescription)
    const table = trimStr(item.fields.table)

    if (!shortDescription) {
      errors.push({ field: `items[${i}].shortDescription`, message: 'Short description is required.', code: 'EMPTY_SHORT_DESCRIPTION' })
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

    if (shortDescription && table) {
      const key = `${shortDescription} ${table}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].shortDescription`,
          message: `Data policy "${shortDescription}" on table "${table}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_IDENTITY',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
