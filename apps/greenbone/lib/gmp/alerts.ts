// =============================================================================
// GMP entity — Alerts (<create_alert>/<get_alerts>/<modify_alert>/
// <delete_alert>). An alert fires a notification method when a condition on an
// event is met. Built on the transport + wire-format primitives in
// ../greenboneApi.ts.
//
// Verified against the GMP 22.5 command reference (cite):
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_create_alert
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_modify_alert
// and python-gvm's request builders (gvm/protocols/gmp/requests/v224/_alerts.py,
// AlertEvent/AlertCondition/AlertMethod enums + the event/condition/method
// compatibility checks).
//
// FLAGS — verify against a live gvmd (GMP is version-specific):
//   * condition/event/method are plain text in the RNC — the enums below are
//     gvmd BUSINESS LOGIC (from python-gvm), not protocol-enforced.
//   * <data> shape is `<data>{value}<name>{key}</name></data>` — value text
//     BEFORE the nested <name> element, per the doc's own example
//     (`<data>5.5<name>severity</name></data>`). Order matters; this is not a
//     generic "attribute bag".
//   * METHODS SCOPED TO NON-SECRET ONLY: SCP/SMB/TippingPoint SMS/verinice
//     Connector (and inferred: Sourcefire Connector, encrypted Email) store a
//     Credential UUID reference (scp_credential/smb_credential/
//     tp_sms_credential/verinice_server_credential/pkcs12_credential/
//     recipient_credential — confirmed via gvmd's manage_sql.c credential-in-use
//     check) — this app does not manage GMP Credentials (secret material, see
//     the app README), so those methods are DELIBERATELY NOT offered here.
//     "Alemba vFire" is also secret-free per the research but its data-field
//     names are not confirmed from a primary source, so it is likewise
//     excluded rather than guessed. Supported: Email (plain, no
//     recipient_credential), HTTP Get, Syslog, Start Task, SNMP (its
//     "community" is a plaintext inline alert field, not a vaulted
//     credential — matches gvmd's own SNMP handling).
//   * test_alert (fires a real test notification) is a runtime action, not
//     config — intentionally not wired to anything here.
//   * ultimate=1 on delete is GMP's general trashcan bypass, applied
//     consistently with every other delete_* in this app.
// =============================================================================

import { attrsFrom, firstChildText, escapeXmlAttr, escapeXmlText } from '../greenboneApi'

export const ALERT_EVENTS = [
  'Task run status changed',
  'New SecInfo arrived',
  'Updated SecInfo arrived',
  'Ticket received',
  'Assigned ticket changed',
  'Owned ticket changed',
] as const

export const ALERT_CONDITIONS = ['Always', 'Error', 'Severity at least', 'Severity changed', 'Filter count changed', 'Filter count at least'] as const

/** Secret-free methods only — see FLAGS. */
export const ALERT_METHODS = ['Email', 'HTTP Get', 'Syslog', 'Start Task', 'SNMP'] as const

export interface AlertDataItem {
  name: string
  value: string
}

export interface AlertClause {
  value: string
  data?: AlertDataItem[]
}

export interface AlertInput {
  name: string
  event: AlertClause
  condition: AlertClause
  method: AlertClause
  comment?: string
}

function buildDataChildren(data?: AlertDataItem[]): string {
  return (data ?? []).map((d) => `<data>${escapeXmlText(d.value)}<name>${escapeXmlText(d.name)}</name></data>`).join('')
}

function buildClause(tag: string, clause: AlertClause): string {
  return `<${tag}>${escapeXmlText(clause.value)}${buildDataChildren(clause.data)}</${tag}>`
}

export function buildGetAlertsCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_alerts filter="${escapeXmlAttr(filter)}"/>`
}

export function buildCreateAlertCommand(a: AlertInput): string {
  const parts = [`<name>${escapeXmlText(a.name)}</name>`, buildClause('condition', a.condition), buildClause('event', a.event), buildClause('method', a.method)]
  if (a.comment && String(a.comment).trim()) parts.push(`<comment>${escapeXmlText(a.comment)}</comment>`)
  return `<create_alert>${parts.join('')}</create_alert>`
}

/** Always resends name/condition/event/method (see gvmd's event/condition/method compatibility matrix — a partial patch risks an inconsistent combination). */
export function buildModifyAlertCommand(alertId: string, a: AlertInput): string {
  const parts = [`<name>${escapeXmlText(a.name)}</name>`, buildClause('condition', a.condition), buildClause('event', a.event), buildClause('method', a.method)]
  if (a.comment !== undefined) parts.push(`<comment>${escapeXmlText(a.comment)}</comment>`)
  return `<modify_alert alert_id="${escapeXmlAttr(alertId)}">${parts.join('')}</modify_alert>`
}

export function buildDeleteAlertCommand(alertId: string, ultimate = true): string {
  return `<delete_alert alert_id="${escapeXmlAttr(alertId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpAlert {
  id: string
  name: string
  comment: string
  event: AlertClause
  condition: AlertClause
  method: AlertClause
}

/** Parse the `value` text (before the first nested <data>/<name>) plus every `<data>` pair inside a clause fragment. */
function parseClause(body: string, tag: string): AlertClause {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(body)
  if (!m) return { value: '', data: [] }
  const inner = m[1]
  const valueMatch = /^([\s\S]*?)(?:<data>|$)/.exec(inner)
  const data: AlertDataItem[] = []
  const dataRe = /<data>([\s\S]*?)<name>([\s\S]*?)<\/name>\s*<\/data>/g
  let dm: RegExpExecArray | null
  while ((dm = dataRe.exec(inner))) {
    data.push({ name: dm[2].trim(), value: dm[1].trim() })
  }
  return { value: (valueMatch?.[1] ?? '').trim(), data }
}

/** Parse `<alert id="…">…</alert>` elements out of a get_alerts_response. */
export function parseAlerts(xml: string): GmpAlert[] {
  const out: GmpAlert[] = []
  const re = /<alert\b([^>]*)>([\s\S]*?)<\/alert>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    out.push({
      id,
      name: firstChildText(body, 'name') ?? '',
      comment: firstChildText(body, 'comment') ?? '',
      event: parseClause(body, 'event'),
      condition: parseClause(body, 'condition'),
      method: parseClause(body, 'method'),
    })
  }
  return out
}
