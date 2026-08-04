// Shared spec for the ServiceNow Assignment Rules config type
// (sysrule_assignment).
//
// An assignment rule automatically populates the assignment_group and/or
// assigned_to fields on a task-derived record after it is saved, when those
// fields are empty and the rule's condition matches. This app manages the
// record as code over the Table API.
//
// sysrule_assignment columns managed below:
//   name         Rule name
//   table        Table the rule applies to — must extend task (identity)
//   active       Enabled flag
//   condition    Encoded query gating the rule
//   group        sys_id of the assignment group to set (raw sys_id)
//   user         sys_id of the user to assign to (raw sys_id)
//   script       Server-side script for scripted assignment (`current` in scope)
//   order        Execution order (lower runs first; default 100)
//   description  Free-text description
//
// Identity is the (name, table) pair — an assignment-rule name is not
// globally unique, so the same name on two different tables is two rules.

import type { TableConfigSpec } from '../../lib/tableConfig'
import { normalizeBool, normalizeInt, trimStr } from '../../lib/tableRecords'

export const SYSRULE_ASSIGNMENT_TABLE = 'sysrule_assignment'

export const TABLE_RE = /^[a-z][a-z0-9_]*$/

export const MANAGED_COLUMNS = ['name', 'table', 'active', 'condition', 'group', 'user', 'script', 'order', 'description'] as const

export const spec: TableConfigSpec = {
  table: SYSRULE_ASSIGNMENT_TABLE,
  managedColumns: MANAGED_COLUMNS,
  identityColumns: ['name', 'table'],
  boolColumns: ['active'],
  intColumns: { order: 100 },
  criticalColumns: ['active', 'group', 'user', 'script'],
  identityOf: (f) => ({ name: trimStr(f.name), table: trimStr(f.table) }),
  labelOf: (f) => `${trimStr(f.name) || '(unnamed)'} (${trimStr(f.table) || '?'})`,
  buildBody: (f) => ({
    name: trimStr(f.name),
    table: trimStr(f.table),
    active: normalizeBool(f.active),
    condition: trimStr(f.condition),
    group: trimStr(f.group),
    user: trimStr(f.user),
    script: String(f.script ?? ''),
    order: normalizeInt(f.order, 100),
    description: trimStr(f.description),
  }),
}
