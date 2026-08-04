import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { trimStr } from '../../lib/tableRecords'
import { buildAclName, OPERATION_VALUES, TABLE_OR_WILDCARD_RE, FIELD_RE } from './_shared'

/**
 * Validate ACL items. Static — no target access required:
 *   - a non-empty table (or "*") matching the table/wildcard shape
 *   - an optional field matching the column-name shape
 *   - a valid operation
 * Identity is (name, operation) where name is derived from table[.field]; a
 * duplicate identity is flagged (last one wins). SECURITY: since role
 * attachment is not managed by this config type, an ACL with neither a
 * condition nor a script passes for every user — flagged as a warning on
 * every such item, not just once, so it is never missed on review.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one ACL.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const table = trimStr(item.fields.table)
    const field = trimStr(item.fields.field)
    const operation = trimStr(item.fields.operation) || 'read'
    const name = buildAclName(item.fields)
    const label = name || '(unnamed)'

    if (!table) {
      errors.push({ field: `items[${i}].table`, message: 'Table is required (use * for a global rule).', code: 'EMPTY_TABLE' })
    } else if (!TABLE_OR_WILDCARD_RE.test(table)) {
      errors.push({
        field: `items[${i}].table`,
        message: `Table "${table}" must be an internal table name (lowercase letters, digits, underscores) or "*".`,
        code: 'INVALID_TABLE',
      })
    }

    if (field && !FIELD_RE.test(field)) {
      errors.push({
        field: `items[${i}].field`,
        message: `Field "${field}" must be an internal column name (lowercase letters, digits, underscores).`,
        code: 'INVALID_FIELD',
      })
    }

    if (!OPERATION_VALUES.has(operation)) {
      errors.push({
        field: `items[${i}].operation`,
        message: `Operation "${operation}" is not a recognized sys_security_acl operation.`,
        code: 'INVALID_OPERATION',
      })
    }

    const condition = trimStr(item.fields.condition)
    const script = trimStr(item.fields.script)
    if (!condition && !script) {
      warnings.push({
        field: `items[${i}].condition`,
        message: `ACL "${label}" [${operation}] has no condition and no script — since role attachment isn't managed by this app, this rule PASSES FOR EVERY USER unless you assign roles to it directly in ServiceNow.`,
        code: 'NO_RESTRICTION',
      })
    }

    if (name) {
      const key = `${name} ${operation}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].table`,
          message: `ACL "${label}" [${operation}] is listed more than once; the last one wins.`,
          code: 'DUPLICATE_IDENTITY',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
