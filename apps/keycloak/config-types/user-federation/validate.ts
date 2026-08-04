import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { AUTH_TYPES, EDIT_MODES, LDAP_VENDORS, SEARCH_SCOPES, readFederationFields } from './_shared'

/**
 * Validate user-federation items: a non-empty name with no whitespace (the
 * upsert identity), a known editMode, and per-providerType required fields —
 * LDAP needs usernameLdapAttribute/rdnLdapAttribute/uuidLdapAttribute/
 * userObjectClasses/connectionUrl/usersDn plus known vendor/authType/
 * searchScope enums and a well-formed customUserSearchFilter; Kerberos (or an
 * LDAP provider with Allow Kerberos authentication on) needs kerberosRealm/
 * serverPrincipal/keyTab. bindDn and bindCredential must be set together
 * (both or neither) — an anonymous bind is valid, a half-configured one is
 * not. Static (no target access), so a blank keyTab/bindCredential that might
 * be an intentional "leave the live value untouched" on an update cannot be
 * distinguished from a genuinely missing one here; deploy owns that nuance
 * for bindCredential (never required outright), while keyTab is required
 * whenever Kerberos is active because — unlike an anonymous LDAP bind —
 * Kerberos/SPNEGO has no valid "off" state once enabled.
 */
const NAME_RE = /^[^\s]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one user federation provider.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = readFederationFields(item.fields)
    const p = `items[${i}]`

    if (!f.name) {
      errors.push({ field: `${p}.name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(f.name)) {
      errors.push({ field: `${p}.name`, message: `Name "${f.name}" must not contain whitespace.`, code: 'INVALID_NAME' })
    } else if (seen.has(f.name)) {
      warnings.push({ field: `${p}.name`, message: `Name ${f.name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(f.name)
    }

    if (!EDIT_MODES.has(f.editMode)) {
      errors.push({
        field: `${p}.editMode`,
        message: `Edit mode "${f.editMode}" is not one of ${[...EDIT_MODES].join(', ')}.`,
        code: 'INVALID_EDIT_MODE',
      })
    }

    if (f.providerType === 'ldap') {
      if (!LDAP_VENDORS.has(f.vendor)) {
        errors.push({
          field: `${p}.vendor`,
          message: `Vendor "${f.vendor}" is not one of ${[...LDAP_VENDORS].join(', ')}.`,
          code: 'INVALID_VENDOR',
        })
      }
      if (!AUTH_TYPES.has(f.authType)) {
        errors.push({
          field: `${p}.authType`,
          message: `Bind type "${f.authType}" is not one of ${[...AUTH_TYPES].join(', ')}.`,
          code: 'INVALID_AUTH_TYPE',
        })
      }
      if (!SEARCH_SCOPES.has(f.searchScope)) {
        errors.push({
          field: `${p}.searchScope`,
          message: `Search scope "${f.searchScope}" is not one of ${[...SEARCH_SCOPES].join(', ')}.`,
          code: 'INVALID_SEARCH_SCOPE',
        })
      }

      if (!f.usernameLdapAttribute) {
        errors.push({ field: `${p}.usernameLdapAttribute`, message: 'Username LDAP attribute is required for an LDAP provider.', code: 'EMPTY_USERNAME_ATTRIBUTE' })
      }
      if (!f.rdnLdapAttribute) {
        errors.push({ field: `${p}.rdnLdapAttribute`, message: 'RDN LDAP attribute is required for an LDAP provider.', code: 'EMPTY_RDN_ATTRIBUTE' })
      }
      if (!f.uuidLdapAttribute) {
        errors.push({ field: `${p}.uuidLdapAttribute`, message: 'UUID LDAP attribute is required for an LDAP provider.', code: 'EMPTY_UUID_ATTRIBUTE' })
      }
      if (f.userObjectClasses.length === 0) {
        errors.push({ field: `${p}.userObjectClasses`, message: 'At least one user object class is required for an LDAP provider.', code: 'EMPTY_USER_OBJECT_CLASSES' })
      }
      if (!f.connectionUrl) {
        errors.push({ field: `${p}.connectionUrl`, message: 'Connection URL is required for an LDAP provider.', code: 'EMPTY_CONNECTION_URL' })
      }
      if (!f.usersDn) {
        errors.push({ field: `${p}.usersDn`, message: 'Users DN is required for an LDAP provider.', code: 'EMPTY_USERS_DN' })
      }

      if (Boolean(f.bindDn) !== Boolean(f.bindCredential)) {
        errors.push({
          field: `${p}.bindDn`,
          message: 'Bind DN and Bind Credential must be set together (both or neither) for an authenticated bind — leave both blank for an anonymous bind.',
          code: 'INCOMPLETE_BIND_CREDENTIALS',
        })
      }

      if (f.customUserSearchFilter && !(f.customUserSearchFilter.startsWith('(') && f.customUserSearchFilter.endsWith(')'))) {
        errors.push({
          field: `${p}.customUserSearchFilter`,
          message: 'Custom user search filter must start with "(" and end with ")".',
          code: 'INVALID_SEARCH_FILTER',
        })
      }
    }

    const kerberosRequired = f.providerType === 'kerberos' || f.allowKerberosAuthentication
    if (kerberosRequired) {
      if (!f.kerberosRealm) {
        errors.push({ field: `${p}.kerberosRealm`, message: 'Kerberos realm is required.', code: 'EMPTY_KERBEROS_REALM' })
      }
      if (!f.serverPrincipal) {
        errors.push({ field: `${p}.serverPrincipal`, message: 'Server principal is required.', code: 'EMPTY_SERVER_PRINCIPAL' })
      }
      if (!f.keyTab) {
        errors.push({ field: `${p}.keyTab`, message: 'Key tab is required.', code: 'EMPTY_KEY_TAB' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
