// Shared spec for the ServiceNow Script Includes config type (sys_script_include).
//
// A script include bundles reusable server-side logic (a class or function)
// callable from business rules, scheduled scripts, other script includes and —
// when client-callable — client scripts via GlideAjax. This app manages the
// record as code over the Table API.
//
// sys_script_include columns managed below:
//   name             Name — must match the class/function it defines (identity)
//   description      Free-text description
//   active           Enabled flag
//   client_callable  Callable from the client via GlideAjax
//   access           Accessible from: "package_private" (default) | "public"
//   script           Server-side script body
//
// NOT managed: api_name — ServiceNow auto-derives it from {scope}.{name} and it
// is read-only in practice, so this app never writes it (see README).
//
// Identity is `name` — a script include's name is its API entry point and is
// unique per scope; operators control it as the natural key.

import type { TableConfigSpec } from '../../lib/tableConfig'
import { normalizeBool, trimStr } from '../../lib/tableRecords'

export const SYS_SCRIPT_INCLUDE_TABLE = 'sys_script_include'

/** Valid `access` values (confirmed via the ServiceNow SDK accessibleFrom property). */
export const ACCESS_VALUES = new Set(['package_private', 'public'])

/** A script-include name must be a valid identifier (it names a class/function). */
export const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/

export const MANAGED_COLUMNS = ['name', 'description', 'active', 'client_callable', 'access', 'script'] as const

export const spec: TableConfigSpec = {
  table: SYS_SCRIPT_INCLUDE_TABLE,
  managedColumns: MANAGED_COLUMNS,
  identityColumns: ['name'],
  boolColumns: ['active', 'client_callable'],
  criticalColumns: ['script', 'active', 'access'],
  identityOf: (f) => ({ name: trimStr(f.name) }),
  labelOf: (f) => trimStr(f.name) || '(unnamed)',
  buildBody: (f) => ({
    name: trimStr(f.name),
    description: trimStr(f.description),
    active: normalizeBool(f.active),
    client_callable: normalizeBool(f.clientCallable),
    access: trimStr(f.access) || 'package_private',
    script: String(f.script ?? ''),
  }),
}
