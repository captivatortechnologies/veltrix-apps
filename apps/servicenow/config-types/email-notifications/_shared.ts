// Shared spec for the ServiceNow Email Notifications config type
// (sysevent_email_action).
//
// A Notification sends email when a system event fires. This app manages
// EVENT-DRIVEN notifications only (event_name required) — the record-based
// "Insert"/"Update" trigger mode uses fields this app does not independently
// verify (see README). Pair this with the Business Rules config type: a rule
// can raise a custom event (gs.eventQueue('my.event', current)) that a
// notification here reacts to, giving you a fully declarative trigger chain.
//
// sysevent_email_action columns managed below:
//   name              Notification name (identity)
//   collection        Table the notification is scoped to (event's table)
//   event_name        The system/custom event that fires this notification (identity)
//   active            Enabled flag
//   condition         Encoded query — additional gate evaluated against the record
//   subject           Email subject line
//   message_html      Email body (HTML)
//   recipient_users   Raw sys_ids of recipient users (comma list)
//   recipient_groups  Raw sys_ids of recipient groups (comma list)
//   recipient_fields  Names of record fields whose user/group value should
//                     also receive the email, e.g. caller_id, assigned_to
//                     (plain field names — no sys_id resolution needed)
//   weight            Processing priority among matching notifications
//   mandatory         Recipients cannot unsubscribe
//   reply_to          Reply-to email address
//
// NOT managed: record-based (non-event) triggering, digest settings, message
// templates/styles, SMS/push variants and dynamic translation — a deliberately
// narrower, high-confidence slice (see README).
//
// Identity is the (name, collection, event_name) triple — the natural key an
// operator controls.

import type { TableConfigSpec } from '../../lib/tableConfig'
import { normalizeBool, normalizeInt, trimStr, readStringArray, joinCsv } from '../../lib/tableRecords'

export const SYSEVENT_EMAIL_ACTION_TABLE = 'sysevent_email_action'

export const TABLE_RE = /^[a-z][a-z0-9_]*$/

export const MANAGED_COLUMNS = [
  'name',
  'collection',
  'event_name',
  'active',
  'condition',
  'subject',
  'message_html',
  'recipient_users',
  'recipient_groups',
  'recipient_fields',
  'weight',
  'mandatory',
  'reply_to',
] as const

export const spec: TableConfigSpec = {
  table: SYSEVENT_EMAIL_ACTION_TABLE,
  managedColumns: MANAGED_COLUMNS,
  identityColumns: ['name', 'collection', 'event_name'],
  boolColumns: ['active', 'mandatory'],
  intColumns: { weight: 0 },
  setColumns: ['recipient_users', 'recipient_groups', 'recipient_fields'],
  criticalColumns: ['active', 'recipient_users', 'recipient_groups', 'condition'],
  identityOf: (f) => ({ name: trimStr(f.name), collection: trimStr(f.collection), event_name: trimStr(f.eventName) }),
  labelOf: (f) => `${trimStr(f.name) || '(unnamed)'} (${trimStr(f.eventName) || '?'})`,
  buildBody: (f) => ({
    name: trimStr(f.name),
    collection: trimStr(f.collection),
    event_name: trimStr(f.eventName),
    active: normalizeBool(f.active),
    condition: trimStr(f.condition),
    subject: trimStr(f.subject),
    message_html: String(f.messageHtml ?? ''),
    recipient_users: joinCsv(readStringArray(f.recipientUsers)),
    recipient_groups: joinCsv(readStringArray(f.recipientGroups)),
    recipient_fields: joinCsv(readStringArray(f.recipientFields)),
    weight: normalizeInt(f.weight, 0),
    mandatory: normalizeBool(f.mandatory),
    reply_to: trimStr(f.replyTo),
  }),
}
