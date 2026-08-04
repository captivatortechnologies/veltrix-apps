// Shared spec for the ServiceNow System Properties config type (sys_properties).
//
// A system property (glide property) is a global instance-wide key/value
// setting — many security-hardening settings (session timeout, login-attempt
// lockout, MFA, CORS allow-lists, ...) are literally sys_properties entries.
// This app manages the record as code over the Table API.
//
// sys_properties columns managed below:
//   name          Property name, conventionally dotted, e.g. glide.security.foo (identity)
//   value         The property's value (a string on the wire regardless of type)
//   type          string | integer | boolean | choicelist | password | password2
//   description   Admin-facing explanation of what the property does
//   is_private    Hide from the System Properties list UI for non-admins
//   ignore_cache  Take effect immediately without a node restart/cache flush
//   read_roles    Roles allowed to READ this property — a comma-separated list
//                 of ROLE NAMES (not sys_ids — sys_properties is one of the
//                 few ServiceNow role-reference fields stored as plain names)
//   write_roles   Roles allowed to WRITE this property — same, role names
//
// PASSWORD-TYPE SAFETY: ServiceNow masks a password/password2 property's value
// on every read (GET never returns the real secret). deploy.ts strips `value`
// from a password-type item's rollback snapshot (so rollback never PATCHes the
// masked placeholder back over the real secret), and driftDetect.ts filters
// out the resulting always-different `value` diff for those items — see both
// files' comments.
//
// Identity is `name` — the natural key an operator controls.

import type { TableConfigSpec } from '../../lib/tableConfig'
import { normalizeBool, trimStr, readStringArray, joinCsv } from '../../lib/tableRecords'

export const SYS_PROPERTIES_TABLE = 'sys_properties'

export const TYPE_VALUES = new Set(['string', 'integer', 'boolean', 'choicelist', 'password', 'password2'])
export const PASSWORD_TYPES = new Set(['password', 'password2'])

export function isPasswordType(type: unknown): boolean {
  return PASSWORD_TYPES.has(trimStr(type))
}

export const MANAGED_COLUMNS = ['name', 'value', 'type', 'description', 'is_private', 'ignore_cache', 'read_roles', 'write_roles'] as const

export const spec: TableConfigSpec = {
  table: SYS_PROPERTIES_TABLE,
  managedColumns: MANAGED_COLUMNS,
  identityColumns: ['name'],
  boolColumns: ['is_private', 'ignore_cache'],
  setColumns: ['read_roles', 'write_roles'],
  criticalColumns: ['value', 'type', 'write_roles'],
  identityOf: (f) => ({ name: trimStr(f.name) }),
  labelOf: (f) => trimStr(f.name) || '(unnamed)',
  buildBody: (f) => ({
    name: trimStr(f.name),
    value: String(f.value ?? ''),
    type: trimStr(f.type) || 'string',
    description: trimStr(f.description),
    is_private: normalizeBool(f.isPrivate),
    ignore_cache: normalizeBool(f.ignoreCache),
    read_roles: joinCsv(readStringArray(f.readRoles)),
    write_roles: joinCsv(readStringArray(f.writeRoles)),
  }),
}
