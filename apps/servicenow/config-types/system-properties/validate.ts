import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { trimStr } from '../../lib/tableRecords'
import { TYPE_VALUES, isPasswordType } from './_shared'

const NAME_CHARSET_RE = /^[A-Za-z][A-Za-z0-9_.]*$/
const HAS_DOT_RE = /\./

/**
 * Validate system-property items. Static — no target access required:
 *   - a non-empty name, warned (not rejected) if it doesn't follow the dotted convention
 *   - a valid type
 *   - a boolean-typed value that looks like true/false; an integer-typed
 *     value that parses as an integer (warnings — ServiceNow itself is the
 *     source of truth for strict validation)
 *   - a password/password2 item always gets a reminder that its value is
 *     write-only (masked on read, not diffed, not restored by rollback)
 * Identity is `name`; a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one system property.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = trimStr(item.fields.name)
    const type = trimStr(item.fields.type) || 'string'
    const value = String(item.fields.value ?? '')

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_CHARSET_RE.test(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Name "${name}" must start with a letter and contain only letters, digits, underscores and dots.`,
        code: 'INVALID_NAME',
      })
    } else if (!HAS_DOT_RE.test(name)) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Name "${name}" doesn't follow ServiceNow's dotted property convention (e.g. glide.security.foo).`,
        code: 'UNCONVENTIONAL_NAME',
      })
    }

    if (!TYPE_VALUES.has(type)) {
      errors.push({
        field: `items[${i}].type`,
        message: `Type must be one of string, integer, boolean, choicelist, password, password2 (got "${type}").`,
        code: 'INVALID_TYPE',
      })
    }

    if (type === 'boolean' && !['true', 'false'].includes(value.trim().toLowerCase())) {
      warnings.push({
        field: `items[${i}].value`,
        message: `Property "${name || '(unnamed)'}" is type boolean but its value "${value}" is not "true" or "false".`,
        code: 'INVALID_BOOLEAN_VALUE',
      })
    }

    if (type === 'integer' && value.trim() !== '' && !/^-?\d+$/.test(value.trim())) {
      warnings.push({
        field: `items[${i}].value`,
        message: `Property "${name || '(unnamed)'}" is type integer but its value "${value}" is not a whole number.`,
        code: 'INVALID_INTEGER_VALUE',
      })
    }

    if (isPasswordType(type)) {
      warnings.push({
        field: `items[${i}].value`,
        message: `Property "${name || '(unnamed)'}" is type ${type} — ServiceNow masks its value on read. Deploy always re-applies the declared value; drift detection skips it and rollback will not restore it.`,
        code: 'PASSWORD_TYPE_NOTICE',
      })
    }

    if (name) {
      if (seen.has(name)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Property "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_IDENTITY',
        })
      } else {
        seen.add(name)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
