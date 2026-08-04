import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeBool, trimStr } from '../../lib/tableRecords'
import { TABLE_RE } from './_shared'

/** Canvas field keys for the placement checkboxes, in the same order as PLACEMENT_COLUMNS. */
const PLACEMENT_FIELD_KEYS = ['formButton', 'formLink', 'formContextMenu', 'listBannerButton', 'listChoice', 'listContextMenu', 'listLink'] as const

/**
 * Validate UI-action items. Static — no target access required:
 *   - a non-empty name and table
 *   - a client action must set an Onclick function
 *   - at least one placement flag must be on, or the action never appears
 * Identity is (name, table); a duplicate pair is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one UI action.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = trimStr(item.fields.name)
    const table = trimStr(item.fields.table)
    const client = normalizeBool(item.fields.client)
    const onclick = trimStr(item.fields.onclick)
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

    if (client && !onclick) {
      errors.push({
        field: `items[${i}].onclick`,
        message: `Action "${name || '(unnamed)'}" is Client but has no Onclick function.`,
        code: 'EMPTY_ONCLICK',
      })
    }

    if (!client && !script) {
      warnings.push({
        field: `items[${i}].script`,
        message: `Action "${name || '(unnamed)'}" is not Client and has no Script — it will do nothing when triggered.`,
        code: 'EMPTY_SERVER_SCRIPT',
      })
    }

    const anyPlacement = PLACEMENT_FIELD_KEYS.some((key) => normalizeBool(item.fields[key]))
    if (!anyPlacement) {
      warnings.push({
        field: `items[${i}].formButton`,
        message: `Action "${name || '(unnamed)'}" has no placement enabled (form button/link/context menu, list banner/choice/context menu/link) — it will never appear anywhere.`,
        code: 'NOT_VISIBLE',
      })
    }

    if (name && table) {
      const key = `${name} ${table}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `UI action "${name}" on table "${table}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_IDENTITY',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
