import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { trimStr } from '../../lib/tableRecords'
import { NAME_RE } from './_shared'

/**
 * Validate role items. Static — no target access required:
 *   - a non-empty name matching the role-name shape (optionally <scope>.<name>)
 * Identity is `name`; a duplicate name is flagged (last one wins). A role with
 * neither a description nor elevated_privilege set is still valid — ServiceNow
 * roles are frequently just a bare grant target for ACLs.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one role.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = trimStr(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Name "${name}" must be letters, digits and underscores, optionally scoped as <scope>.<name>.`,
        code: 'INVALID_NAME',
      })
    }

    if (!trimStr(item.fields.description)) {
      warnings.push({
        field: `items[${i}].description`,
        message: `Role "${name || '(unnamed)'}" has no description — future admins won't know what it grants.`,
        code: 'MISSING_DESCRIPTION',
      })
    }

    if (name) {
      if (seen.has(name)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Role "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_IDENTITY',
        })
      } else {
        seen.add(name)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
