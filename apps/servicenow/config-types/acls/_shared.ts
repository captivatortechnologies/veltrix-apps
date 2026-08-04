// Shared spec for the ServiceNow ACLs config type (sys_security_acl).
//
// An Access Control Rule (ACL) is ServiceNow's core RBAC-enforcement record —
// it gates create/read/write/delete/execute (and several specialized
// operations) against a table, a specific field, or a named resource. This
// app manages the record RECORD as code over the Table API, scoped to
// `type: record` (table/field security) — the overwhelmingly common SecOps
// use case. Non-record ACL types (REST endpoints, UI pages, script includes,
// GraphQL, UX routes, ...) are out of scope (see README).
//
// sys_security_acl columns managed below:
//   name             For type=record: the table, or "table.field" for a
//                    field-level rule, or "*" / "*.field" for a global rule.
//                    DERIVED here from the canvas's separate `table` + `field`
//                    inputs — see buildAclName below.
//   type             Fixed to "record" (this config type's scope) — not a
//                    canvas field.
//   operation        create | read | write | delete | execute | report_on |
//                    and ServiceNow's specialized operations (see
//                    OPERATION_VALUES) — confirmed against the ServiceNow SDK.
//   active           Enabled flag
//   admin_overrides  Users with the admin role automatically pass this rule
//   condition        Encoded query the record must satisfy to pass
//   script           Server script; must set the `answer` variable
//   description      Free-text description
//
// NOT managed: role attachment. Which roles satisfy an ACL lives in the
// many-to-many join table sys_security_acl_role, not a column on this
// record — the same "related list, out of scope" pattern UI Policies already
// applies to sys_ui_policy_action. Assign roles to a managed ACL directly in
// ServiceNow, or gate it entirely with `condition` / `script` instead (see
// the SECURITY note in README: an ACL with no roles, no condition and no
// script PASSES for everyone).
//
// Identity is the (name, operation) pair — the natural key an operator
// controls. ServiceNow allows more than one ACL for the same (name,
// operation) — they combine with OR — so this identity governs only the
// records THIS app created/updates, same caveat as the other config types.

import type { TableConfigSpec } from '../../lib/tableConfig'
import { normalizeBool, trimStr } from '../../lib/tableRecords'

export const SYS_SECURITY_ACL_TABLE = 'sys_security_acl'

/** Confirmed operation values (ServiceNow SDK Acl() operation enum). */
export const OPERATION_VALUES = new Set([
  'create',
  'read',
  'write',
  'delete',
  'execute',
  'report_on',
  'query_match',
  'query_range',
  'conditional_table_query_range',
  'data_fabric',
  'edit_task_relations',
  'edit_ci_relations',
  'save_as_template',
  'add_to_list',
  'list_edit',
  'report_view',
  'personalize_choices',
])

/** A table/field name — lowercase, digits, underscores — or "*" for the global-rule wildcard. */
export const TABLE_OR_WILDCARD_RE = /^(\*|[a-z][a-z0-9_]*)$/
export const FIELD_RE = /^[a-z][a-z0-9_]*$/

/** ACL name for type=record: "table", "table.field", "*" or "*.field". */
export function buildAclName(fields: Record<string, unknown>): string {
  const table = trimStr(fields.table)
  const field = trimStr(fields.field)
  return field ? `${table}.${field}` : table
}

export const MANAGED_COLUMNS = ['name', 'type', 'operation', 'active', 'admin_overrides', 'condition', 'script', 'description'] as const

export const spec: TableConfigSpec = {
  table: SYS_SECURITY_ACL_TABLE,
  managedColumns: MANAGED_COLUMNS,
  identityColumns: ['name', 'operation'],
  boolColumns: ['active', 'admin_overrides'],
  criticalColumns: ['active', 'operation', 'condition', 'script'],
  identityOf: (f) => ({ name: buildAclName(f), operation: trimStr(f.operation) }),
  labelOf: (f) => `${buildAclName(f) || '(unnamed)'} [${trimStr(f.operation) || '?'}]`,
  buildBody: (f) => ({
    name: buildAclName(f),
    type: 'record',
    operation: trimStr(f.operation),
    active: normalizeBool(f.active),
    admin_overrides: normalizeBool(f.adminOverrides),
    condition: trimStr(f.condition),
    script: String(f.script ?? ''),
    description: trimStr(f.description),
  }),
}
