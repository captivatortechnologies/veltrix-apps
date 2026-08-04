import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractLdapServerSettingsSpecs, LDAP_ACTIONS } from './_shared'

/**
 * Validate LDAP Server Settings items: a non-empty, unique name (the logical
 * identity — matched against an EXISTING server, since this config type cannot
 * create one) and, when set, a recognized lockout / password-expiration action.
 * Static — no target access required; a missing target server surfaces at
 * deploy time (it needs the org's LDAP server list to detect).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractLdapServerSettingsSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one LDAP Server Settings item.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'LDAP server name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 255) {
      errors.push({ field: `${prefix}.name`, message: 'LDAP server name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    } else if (seen.has(spec.name.toLowerCase())) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate LDAP server "${spec.name}" — each server may only be declared once per canvas.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    for (const [field, value] of [
      ['userLockoutAction', spec.userLockoutAction],
      ['userPasswordExpirationAction', spec.userPasswordExpirationAction],
    ] as const) {
      if (value && !(LDAP_ACTIONS as readonly string[]).includes(value)) {
        errors.push({ field: `${prefix}.${field}`, message: `${field} must be one of: ${LDAP_ACTIONS.join(', ')}.`, code: 'INVALID_ACTION' })
      }
    }

    if (!spec.userLockoutAction && !spec.userPasswordExpirationAction) {
      warnings.push({
        field: prefix,
        message: `"${spec.name || 'server'}" leaves both lockout and password-expiration actions unmanaged — deploy will only (re)apply the name.`,
        code: 'NO_ACTIONS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
