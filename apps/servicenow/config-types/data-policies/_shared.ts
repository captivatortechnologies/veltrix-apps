// Shared spec for the ServiceNow Data Policies config type (sys_data_policy2).
//
// A data policy enforces field-level mandatory/read-only rules SERVER-SIDE
// (import sets, web services, the UI) for a table, evaluated against a
// condition. This app manages the policy RECORD as code over the Table API;
// the per-field rules (the child sys_data_policy_rule table) are out of scope
// — the same "related list, out of scope" pattern already applied to UI
// Policies' sys_ui_policy_action (see README). Add the field rules directly
// in ServiceNow after the header deploys.
//
// sys_data_policy2 columns managed below:
//   short_description  Short description (identity-ish, human name)
//   table              Table the policy applies to (e.g. incident)
//   description        Free-text description
//   active             Enabled flag
//   order              Execution order (lower runs first; default 100)
//   conditions         Encoded query deciding when the policy applies
//   enforce_ui         Also apply the policy's rules as client-side UI Policy behavior
//   reverse_if_false   Reverse the rules when the condition is false
//   inherit            Apply to tables that extend the table above
//
// Identity is the (short_description, table) pair — a short description is
// not globally unique, so the same name on two tables is two different
// policies (same identity shape as UI Policies).

import type { TableConfigSpec } from '../../lib/tableConfig'
import { normalizeBool, normalizeInt, trimStr } from '../../lib/tableRecords'

export const SYS_DATA_POLICY_TABLE = 'sys_data_policy2'

export const TABLE_RE = /^[a-z][a-z0-9_]*$/

export const MANAGED_COLUMNS = [
  'short_description',
  'table',
  'description',
  'active',
  'order',
  'conditions',
  'enforce_ui',
  'reverse_if_false',
  'inherit',
] as const

export const spec: TableConfigSpec = {
  table: SYS_DATA_POLICY_TABLE,
  managedColumns: MANAGED_COLUMNS,
  identityColumns: ['short_description', 'table'],
  boolColumns: ['active', 'enforce_ui', 'reverse_if_false', 'inherit'],
  intColumns: { order: 100 },
  criticalColumns: ['active', 'conditions'],
  identityOf: (f) => ({ short_description: trimStr(f.shortDescription), table: trimStr(f.table) }),
  labelOf: (f) => `${trimStr(f.shortDescription) || '(unnamed)'} (${trimStr(f.table) || '?'})`,
  buildBody: (f) => ({
    short_description: trimStr(f.shortDescription),
    table: trimStr(f.table),
    description: trimStr(f.description),
    active: normalizeBool(f.active),
    order: normalizeInt(f.order, 100),
    conditions: trimStr(f.conditions),
    enforce_ui: normalizeBool(f.enforceUi),
    reverse_if_false: normalizeBool(f.reverseIfFalse),
    inherit: normalizeBool(f.inherit),
  }),
}
