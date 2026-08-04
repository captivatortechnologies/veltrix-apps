import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { trimStr } from '../../lib/tableRecords'
import { TABLE_RE, TYPE_VALUES, FIELD_TRIGGERED_TYPES, UI_TYPE_VALUES } from './_shared'

/**
 * Validate client-script items. Static — no target access required:
 *   - a non-empty name, table and script
 *   - a valid type (onLoad | onChange | onSubmit | onCellEdit)
 *   - a field name for onChange/onCellEdit; flagged as unused otherwise
 *   - a valid ui_type
 * Identity is (name, table, type); a duplicate triple is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one client script.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = trimStr(item.fields.name)
    const table = trimStr(item.fields.table)
    const type = trimStr(item.fields.type) || 'onLoad'
    const fieldName = trimStr(item.fields.fieldName)
    const script = trimStr(item.fields.script)
    const uiType = trimStr(item.fields.uiType) || 'all'

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

    if (!TYPE_VALUES.has(type)) {
      errors.push({
        field: `items[${i}].type`,
        message: `Type must be one of onLoad, onChange, onSubmit, onCellEdit (got "${type}").`,
        code: 'INVALID_TYPE',
      })
    }

    if (FIELD_TRIGGERED_TYPES.has(type) && !fieldName) {
      errors.push({
        field: `items[${i}].fieldName`,
        message: `Type "${type}" requires a field name.`,
        code: 'EMPTY_FIELD_NAME',
      })
    } else if (!FIELD_TRIGGERED_TYPES.has(type) && fieldName) {
      warnings.push({
        field: `items[${i}].fieldName`,
        message: `Field name is ignored for type "${type}" (only onChange/onCellEdit use it).`,
        code: 'UNUSED_FIELD_NAME',
      })
    }

    if (!script) {
      errors.push({ field: `items[${i}].script`, message: 'Script is required.', code: 'EMPTY_SCRIPT' })
    }

    if (!UI_TYPE_VALUES.has(uiType)) {
      errors.push({
        field: `items[${i}].uiType`,
        message: `UI type must be one of desktop, mobile_or_service_portal, all (got "${uiType}").`,
        code: 'INVALID_UI_TYPE',
      })
    }

    if (name && table) {
      const key = `${name} ${table} ${type}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Client script "${name}" on "${table}" (${type}) is listed more than once; the last one wins.`,
          code: 'DUPLICATE_IDENTITY',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
