// Shared spec for the ServiceNow Roles config type (sys_user_role).
//
// A role is a named permission grant an admin assigns to users/groups; it is
// the primary unit of RBAC in ServiceNow and is frequently paired with the
// ACLs config type (an ACL restricts access to users who hold a role). This
// app manages the role RECORD as code over the Table API.
//
// sys_user_role columns managed below:
//   name                 Role name — scoped-app roles use "<scope>.<name>" (identity)
//   description          Free-text description of what the role grants
//   elevated_privilege   Requires the user to explicitly elevate to this role before use
//   requires_subscription  Role is gated behind a licensed subscription
//   assignable_by        Other roles that may assign this role to a user — a
//                        ServiceNow list column; this app stores it as a
//                        RAW, comma-separated list of role sys_ids (same raw-
//                        sys_id convention as scheduled-jobs' run_as) since
//                        resolving names to ids needs a live lookup this
//                        engine's synchronous buildBody cannot perform.
//
// NOT managed: role containment / inheritance (the "Contains Roles" related
// list, table sys_user_role_contains_roles) — a many-to-many join table, out
// of scope for the same reason UI Policies excludes sys_ui_policy_action (see
// README). Manage role inheritance directly in ServiceNow.
//
// Identity is `name` — the natural key an operator controls. ServiceNow does
// not allow renaming a role after it is saved, so a rename in the canvas
// creates a NEW role rather than renaming the live one (see README).

import type { TableConfigSpec } from '../../lib/tableConfig'
import { normalizeBool, trimStr, readStringArray, joinCsv } from '../../lib/tableRecords'

export const SYS_USER_ROLE_TABLE = 'sys_user_role'

/** A role name (optionally scoped as "<scope>.<name>"). */
export const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/

export const MANAGED_COLUMNS = [
  'name',
  'description',
  'elevated_privilege',
  'requires_subscription',
  'assignable_by',
] as const

export const spec: TableConfigSpec = {
  table: SYS_USER_ROLE_TABLE,
  managedColumns: MANAGED_COLUMNS,
  identityColumns: ['name'],
  boolColumns: ['elevated_privilege', 'requires_subscription'],
  setColumns: ['assignable_by'],
  criticalColumns: ['elevated_privilege', 'name'],
  identityOf: (f) => ({ name: trimStr(f.name) }),
  labelOf: (f) => trimStr(f.name) || '(unnamed)',
  buildBody: (f) => ({
    name: trimStr(f.name),
    description: trimStr(f.description),
    elevated_privilege: normalizeBool(f.elevatedPrivilege),
    requires_subscription: normalizeBool(f.requiresSubscription),
    assignable_by: joinCsv(readStringArray(f.assignableBy)),
  }),
}
