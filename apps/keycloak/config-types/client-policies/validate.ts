import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString, readStringArray } from '../../lib/fields'
import { parseConditionsField } from './_shared'

/**
 * Validate client-policy items: a non-empty, whitespace-free `name`, and — because
 * this config type is a realm-wide whole-list PUT covering every declared item — a
 * duplicate name is an ERROR here, not the usual warn-and-last-one-wins. Keycloak
 * itself also rejects a duplicate custom policy name at deploy time (see _shared.ts).
 * `conditions`, when present, must parse to a JSON array of `{ condition,
 * configuration? }` objects. `profiles` referencing a real Client Profile cannot be
 * verified here (static — no target access), so an empty `profiles` list is only a
 * warning: the policy is well-formed but enforces nothing until a profile is added.
 */
const POLICY_NAME_RE = /^[^\s]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one client policy.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const name = readString(item.fields.name)
    const prefix = `items[${i}]`

    if (!name) {
      errors.push({ field: `${prefix}.name`, message: 'Client policy name is required.', code: 'EMPTY_POLICY_NAME' })
    } else if (!POLICY_NAME_RE.test(name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Client policy name "${name}" must not contain whitespace.`,
        code: 'INVALID_POLICY_NAME',
      })
    } else if (seen.has(name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Client policy name "${name}" is listed more than once — this config type writes the complete policy list in one request, so duplicate names must be resolved.`,
        code: 'DUPLICATE_POLICY_NAME',
      })
    } else {
      seen.add(name)
    }

    const { error } = parseConditionsField(item.fields.conditions)
    if (error) {
      errors.push({ field: `${prefix}.conditions`, message: error, code: 'INVALID_CONDITIONS' })
    }

    const profiles = readStringArray(item.fields.profiles)
    if (profiles.length === 0) {
      warnings.push({
        field: `${prefix}.profiles`,
        message: `Client policy "${name || '(unnamed)'}" applies no profiles — it will match clients but enforce nothing until at least one profile is added.`,
        code: 'EMPTY_PROFILES',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
