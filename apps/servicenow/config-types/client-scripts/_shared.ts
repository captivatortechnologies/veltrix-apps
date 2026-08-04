// Shared spec for the ServiceNow Client Scripts config type (sys_script_client).
//
// A client script runs JavaScript in the browser on a form event (onLoad,
// onChange, onSubmit, onCellEdit) — the client-side counterpart to Business
// Rules. This app manages the record as code over the Table API.
//
// sys_script_client columns managed below:
//   name              Script name
//   table             Table the script runs on (identity)
//   type              onLoad | onChange | onSubmit | onCellEdit (identity)
//   field_name        Field that triggers the script — required for onChange/onCellEdit
//   script            Client-side script body
//   active            Enabled flag
//   global            Apply to all views (false = the view(s) configured in ServiceNow)
//   order             Execution order (lower runs first; default 100)
//   description       Free-text description
//   applies_extended  Also run on tables that extend the table above
//   isolate_script    Run in strict mode, isolated from other client scripts
//   ui_type           desktop | mobile_or_service_portal | all — NOTE this is a
//                     string enum, unlike sys_ui_policy.ui_type's integer codes
//                     ("0"/"1"/"10") — a genuine platform inconsistency (see README)
//
// NOT managed: localized message strings and per-view scoping (the `view`
// related list) — low-signal for SecOps and not independently verified to
// this app's confidence bar.
//
// Identity is the (name, table, type) triple — a client-script name is not
// unique, and the same name/table pair commonly exists for two different
// trigger types.

import type { TableConfigSpec } from '../../lib/tableConfig'
import { normalizeBool, normalizeInt, trimStr } from '../../lib/tableRecords'

export const SYS_SCRIPT_CLIENT_TABLE = 'sys_script_client'

export const TABLE_RE = /^[a-z][a-z0-9_]*$/
export const TYPE_VALUES = new Set(['onLoad', 'onChange', 'onSubmit', 'onCellEdit'])
export const FIELD_TRIGGERED_TYPES = new Set(['onChange', 'onCellEdit'])
export const UI_TYPE_VALUES = new Set(['desktop', 'mobile_or_service_portal', 'all'])

export const MANAGED_COLUMNS = [
  'name',
  'table',
  'type',
  'field_name',
  'script',
  'active',
  'global',
  'order',
  'description',
  'applies_extended',
  'isolate_script',
  'ui_type',
] as const

export const spec: TableConfigSpec = {
  table: SYS_SCRIPT_CLIENT_TABLE,
  managedColumns: MANAGED_COLUMNS,
  identityColumns: ['name', 'table', 'type'],
  boolColumns: ['active', 'global', 'applies_extended', 'isolate_script'],
  intColumns: { order: 100 },
  criticalColumns: ['active', 'script', 'type'],
  identityOf: (f) => ({ name: trimStr(f.name), table: trimStr(f.table), type: trimStr(f.type) }),
  labelOf: (f) => `${trimStr(f.name) || '(unnamed)'} (${trimStr(f.table) || '?'}/${trimStr(f.type) || '?'})`,
  buildBody: (f) => ({
    name: trimStr(f.name),
    table: trimStr(f.table),
    type: trimStr(f.type),
    field_name: trimStr(f.fieldName),
    script: String(f.script ?? ''),
    active: normalizeBool(f.active),
    global: normalizeBool(f.global),
    order: normalizeInt(f.order, 100),
    description: trimStr(f.description),
    applies_extended: normalizeBool(f.appliesExtended),
    isolate_script: normalizeBool(f.isolateScript),
    ui_type: trimStr(f.uiType) || 'all',
  }),
}
