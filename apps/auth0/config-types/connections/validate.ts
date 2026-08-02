import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonObject, readString, readStringArray } from '../../lib/fields'
import { CONNECTION_STRATEGIES } from './_shared'

/**
 * Validate Auth0 connection items: a non-empty name matching Auth0's naming rule
 * (1–128 chars, alphanumeric + hyphens, alphanumeric at each end), a known
 * strategy, and — when present — a well-formed JSON options object. Static: no
 * target access required. The connection name is the upsert identity, so a
 * duplicate name is flagged (last one wins).
 */
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one connection.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = readString(item.fields.name)
    const strategy = readString(item.fields.strategy)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Connection name is required.', code: 'EMPTY_NAME' })
    } else {
      if (name.length > 128 || !NAME_RE.test(name)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Connection name "${name}" must be 1–128 characters, alphanumeric and hyphens, starting and ending with an alphanumeric character.`,
          code: 'INVALID_NAME',
        })
      }
      if (seen.has(name)) {
        warnings.push({ field: `items[${i}].name`, message: `Connection name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(name)
      }
    }

    if (!CONNECTION_STRATEGIES.has(strategy)) {
      errors.push({
        field: `items[${i}].strategy`,
        message: `Connection strategy "${strategy}" is not one of the supported strategies (${[...CONNECTION_STRATEGIES].join(', ')}).`,
        code: 'INVALID_STRATEGY',
      })
    }

    const options = parseJsonObject(item.fields.options)
    if (!options.ok) {
      errors.push({ field: `items[${i}].options`, message: `Options ${options.error}.`, code: 'INVALID_OPTIONS' })
    }

    for (const client of readStringArray(item.fields.enabled_clients)) {
      if (/\s/.test(client)) {
        errors.push({
          field: `items[${i}].enabled_clients`,
          message: `Enabled client id "${client}" must not contain whitespace.`,
          code: 'INVALID_ENABLED_CLIENT',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
