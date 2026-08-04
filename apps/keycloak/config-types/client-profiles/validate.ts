import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'
import { parseExecutorsField } from './_shared'

/**
 * Validate client-profile items: a non-empty, whitespace-free `name`, and — because
 * this config type is a realm-wide whole-list PUT covering every declared item — a
 * duplicate name is an ERROR here, not the usual warn-and-last-one-wins. Keycloak
 * itself also rejects a duplicate custom profile name at deploy time (see _shared.ts).
 * `executors`, when present, must parse to a JSON array of `{ executor, configuration?
 * }` objects. Static — no target access; the executor id itself is not verified
 * against Keycloak's live provider registry.
 */
const PROFILE_NAME_RE = /^[^\s]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one client profile.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const name = readString(item.fields.name)
    const prefix = `items[${i}]`

    if (!name) {
      errors.push({ field: `${prefix}.name`, message: 'Client profile name is required.', code: 'EMPTY_PROFILE_NAME' })
    } else if (!PROFILE_NAME_RE.test(name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Client profile name "${name}" must not contain whitespace.`,
        code: 'INVALID_PROFILE_NAME',
      })
    } else if (seen.has(name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Client profile name "${name}" is listed more than once — this config type writes the complete profile list in one request, so duplicate names must be resolved.`,
        code: 'DUPLICATE_PROFILE_NAME',
      })
    } else {
      seen.add(name)
    }

    const { error } = parseExecutorsField(item.fields.executors)
    if (error) {
      errors.push({ field: `${prefix}.executors`, message: error, code: 'INVALID_EXECUTORS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
