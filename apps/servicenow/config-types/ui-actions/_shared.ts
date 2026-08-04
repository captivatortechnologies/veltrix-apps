// Shared spec for the ServiceNow UI Actions config type (sys_ui_action).
//
// A UI action creates a button, link or context-menu item on a form or list
// that runs server and/or client script when triggered — the manually-invoked
// counterpart to Business Rules (which fire on database operations). This app
// manages the record as code over the Table API.
//
// sys_ui_action columns managed below:
//   name                Name shown in the list view (identity-ish, human name)
//   table               Table the action appears on (identity)
//   action_name         Internal identifier scripts use to detect this action fired
//   active              Enabled flag
//   client              Runs client-side (calls onclick) instead of/before the server script
//   onclick             Client-side function to call when Client is on
//   isolate_script      Run the script in a scoped, isolated context
//   condition           Encoded query / script-like condition controlling visibility
//   script              Server-side script body
//   order               Execution/display order (lower runs first; default 100)
//   hint                Tooltip text
//   comments            Free-text description
//   Placement flags — where the action appears (all booleans, confirmed
//   against the ServiceNow SDK UiAction API + independent placement-type docs):
//     form_button          Button on the form
//     form_link            Related link on the form
//     form_context_menu    Right-click context menu on the form
//     list_banner_button   Button above a list
//     list_choice          Choice in a list's "Actions on selected rows" menu
//     list_context_menu    Right-click context menu on a list row
//     list_link            Related link on a list
//   Show flags — which record states offer the action:
//     show_insert          Offer on a new (unsaved) record
//     show_update          Offer on an existing (saved) record
//     show_query           Offer on the table's search/query view
//     show_multiple_update Offer as a list batch action across selected rows
//
// Identity is the (name, table) pair — a UI-action name is not globally
// unique, so the same name on two different tables is two different actions.

import type { TableConfigSpec } from '../../lib/tableConfig'
import { normalizeBool, normalizeInt, trimStr } from '../../lib/tableRecords'

export const SYS_UI_ACTION_TABLE = 'sys_ui_action'

export const TABLE_RE = /^[a-z][a-z0-9_]*$/

export const PLACEMENT_COLUMNS = [
  'form_button',
  'form_link',
  'form_context_menu',
  'list_banner_button',
  'list_choice',
  'list_context_menu',
  'list_link',
] as const

export const SHOW_COLUMNS = ['show_insert', 'show_update', 'show_query', 'show_multiple_update'] as const

export const MANAGED_COLUMNS = [
  'name',
  'table',
  'action_name',
  'active',
  'client',
  'onclick',
  'isolate_script',
  'condition',
  'script',
  'order',
  'hint',
  'comments',
  ...PLACEMENT_COLUMNS,
  ...SHOW_COLUMNS,
] as const

export const spec: TableConfigSpec = {
  table: SYS_UI_ACTION_TABLE,
  managedColumns: MANAGED_COLUMNS,
  identityColumns: ['name', 'table'],
  boolColumns: ['active', 'client', 'isolate_script', ...PLACEMENT_COLUMNS, ...SHOW_COLUMNS],
  intColumns: { order: 100 },
  criticalColumns: ['active', 'script', 'condition', 'client'],
  identityOf: (f) => ({ name: trimStr(f.name), table: trimStr(f.table) }),
  labelOf: (f) => `${trimStr(f.name) || '(unnamed)'} (${trimStr(f.table) || '?'})`,
  buildBody: (f) => ({
    name: trimStr(f.name),
    table: trimStr(f.table),
    action_name: trimStr(f.actionName),
    active: normalizeBool(f.active),
    client: normalizeBool(f.client),
    onclick: trimStr(f.onclick),
    isolate_script: normalizeBool(f.isolateScript),
    condition: trimStr(f.condition),
    script: String(f.script ?? ''),
    order: normalizeInt(f.order, 100),
    hint: trimStr(f.hint),
    comments: trimStr(f.comments),
    form_button: normalizeBool(f.formButton),
    form_link: normalizeBool(f.formLink),
    form_context_menu: normalizeBool(f.formContextMenu),
    list_banner_button: normalizeBool(f.listBannerButton),
    list_choice: normalizeBool(f.listChoice),
    list_context_menu: normalizeBool(f.listContextMenu),
    list_link: normalizeBool(f.listLink),
    show_insert: normalizeBool(f.showInsert),
    show_update: normalizeBool(f.showUpdate),
    show_query: normalizeBool(f.showQuery),
    show_multiple_update: normalizeBool(f.showMultipleUpdate),
  }),
}
