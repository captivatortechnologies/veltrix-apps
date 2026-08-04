import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { text, readOrgRoles, parseExpiresAt, KNOWN_ROLE_HINTS } from './_shared'

/**
 * Validate Group items: a non-empty name is required (it doubles as the identity). Role values
 * are checked against a small set of known hints and warned on (never blocked) — see the ROLE
 * VOCABULARY note in _shared.ts. A malformed expiresAt is warned on (deploy will simply omit it,
 * leaving the group non-expiring, rather than failing). Static — no target access required. A
 * duplicate name is flagged (last wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = text(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Group name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Group name "${name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(name.toLowerCase())
    }

    const expiresAtRaw = text(item.fields.expiresAt)
    if (expiresAtRaw && parseExpiresAt(expiresAtRaw) === undefined) {
      warnings.push({
        field: `items[${i}].expiresAt`,
        message: `"${expiresAtRaw}" could not be parsed as a date or epoch timestamp — it will be ignored (group stays non-expiring).`,
        code: 'UNPARSEABLE_EXPIRY',
      })
    }

    const defaultRole = text(item.fields.orgDefaultRole)
    if (defaultRole && !(KNOWN_ROLE_HINTS as readonly string[]).includes(defaultRole.toLowerCase())) {
      warnings.push({
        field: `items[${i}].orgDefaultRole`,
        message: `Role "${defaultRole}" is not one of the commonly documented roles (${KNOWN_ROLE_HINTS.join(', ')}) — runZero may reject it.`,
        code: 'UNRECOGNIZED_ROLE',
      })
    }

    const orgRoles = readOrgRoles(item.fields.orgRoles)
    for (const [orgId, role] of Object.entries(orgRoles)) {
      if (role && !(KNOWN_ROLE_HINTS as readonly string[]).includes(role.toLowerCase())) {
        warnings.push({
          field: `items[${i}].orgRoles.${orgId}`,
          message: `Role "${role}" is not one of the commonly documented roles (${KNOWN_ROLE_HINTS.join(', ')}) — runZero may reject it.`,
          code: 'UNRECOGNIZED_ROLE',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
