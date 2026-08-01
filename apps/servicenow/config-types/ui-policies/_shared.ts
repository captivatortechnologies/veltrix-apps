// Shared spec for the ServiceNow UI Policies config type (sys_ui_policy).
//
// A UI policy defines client-side form behavior (show/hide, mandatory,
// read-only) for a table, evaluated against a condition. This app manages the
// policy RECORD as code over the Table API; per-policy field actions live in
// the child sys_ui_policy_action table and are out of scope here.
//
// sys_ui_policy columns managed below:
//   short_description  Short description (identity-ish, human name)
//   table              Table the policy applies to (e.g. incident)
//   description        Free-text description
//   ui_type            Where it runs: "0" Desktop | "1" Mobile / Service Portal | "10" All
//   active             Enabled flag
//   global             Apply on all views
//   on_load            Run when the form loads (not only on field change)
//   reverse_if_false   Reverse the actions when the condition is false
//   run_scripts        Allow the advanced true/false scripts to run
//   order              Execution order (lower runs first; default 100)
//   conditions         Encoded query deciding when the policy applies
//
// Identity is the (short_description, table) pair — a short description is not
// globally unique, so the same name on two tables is two different policies.

import type { TableConfigSpec } from '../../lib/tableConfig'
import { normalizeBool, normalizeInt, trimStr } from '../../lib/tableRecords'

export const SYS_UI_POLICY_TABLE = 'sys_ui_policy'

/** Valid ui_type stored values (integers as strings). See README — verify against your instance. */
export const UI_TYPE_VALUES = new Set(['0', '1', '10'])

export const MANAGED_COLUMNS = [
  'short_description',
  'table',
  'description',
  'ui_type',
  'active',
  'global',
  'on_load',
  'reverse_if_false',
  'run_scripts',
  'order',
  'conditions',
] as const

export const spec: TableConfigSpec = {
  table: SYS_UI_POLICY_TABLE,
  managedColumns: MANAGED_COLUMNS,
  identityColumns: ['short_description', 'table'],
  boolColumns: ['active', 'global', 'on_load', 'reverse_if_false', 'run_scripts'],
  intColumns: { order: 100 },
  criticalColumns: ['active', 'conditions'],
  identityOf: (f) => ({ short_description: trimStr(f.shortDescription), table: trimStr(f.table) }),
  labelOf: (f) => `${trimStr(f.shortDescription) || '(unnamed)'} (${trimStr(f.table) || '?'})`,
  buildBody: (f) => ({
    short_description: trimStr(f.shortDescription),
    table: trimStr(f.table),
    description: trimStr(f.description),
    ui_type: trimStr(f.uiType) || '10',
    active: normalizeBool(f.active),
    global: normalizeBool(f.global),
    on_load: normalizeBool(f.onLoad),
    reverse_if_false: normalizeBool(f.reverseIfFalse),
    run_scripts: normalizeBool(f.runScripts),
    order: normalizeInt(f.order, 100),
    conditions: trimStr(f.conditions),
  }),
}
