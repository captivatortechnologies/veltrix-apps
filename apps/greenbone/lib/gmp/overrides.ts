// =============================================================================
// GMP entity — Overrides (<create_override>/<get_overrides>/
// <modify_override>/<delete_override>). A persistent, re-appliable rule that
// changes the reported SEVERITY of a specific NVT's results (a risk-acceptance
// / false-positive annotation), optionally scoped to hosts/port/task/result.
// Built on the transport + wire-format primitives in ../greenboneApi.ts.
//
// Verified against the GMP 22.5 command reference's <override> response
// element (cite):
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#element_override
// and python-gvm's request builders (gvm/protocols/gmp/requests/v224/_overrides.py,
// Overrides.create_override/modify_override — the create-command's own doc
// section was not in the fetched window; the response-element shape plus the
// client library's field set together confirm the write-side schema below).
//
// FLAGS:
//   * NO NATURAL NAME: an override has no name field at all — identity is
//     purely a server UUID. This config type tracks identity by the CANVAS
//     ITEM's own stable id (the pfsense/static-routes pattern — see
//     config-types/overrides/_shared.ts), not by matching content.
//   * `active` on WRITE is a days-count convenience (-1 always, 0 off, N days)
//     — python-gvm's `days_active` param. The READ-side representation gvmd
//     echoes back (boolean-ish `<active>`/possible `<end_time>`) is not
//     independently re-verified here to correspond 1:1 with the write-side
//     day count, so this app does not diff "active" in drift — it is always
//     RE-APPLIED as declared on every deploy (see driftDetect.ts's FLAG).
//   * `severity`/`new_severity` are the GMP severity scale (0.0–10.0), with
//     -1 as the documented "False Positive" special value and 0 as "Log" —
//     validate.ts enforces this range without over-claiming other specials.
//   * ultimate=1 on delete is GMP's general trashcan bypass, applied
//     consistently with every other delete_* in this app.
// =============================================================================

import { attrsFrom, firstChildText, idAttrOf, escapeXmlAttr, escapeXmlText } from '../greenboneApi'

export function buildGetOverridesCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_overrides filter="${escapeXmlAttr(filter)}"/>`
}

export interface OverrideInput {
  text: string
  nvtOid: string
  hosts?: string
  port?: string
  severity?: number
  newSeverity: number
  daysActive?: number
  taskId?: string
  resultId?: string
}

function buildOverrideBody(o: OverrideInput): string {
  const parts = [`<text>${escapeXmlText(o.text)}</text>`, `<nvt oid="${escapeXmlAttr(o.nvtOid)}"/>`]
  if (o.hosts && String(o.hosts).trim()) parts.push(`<hosts>${escapeXmlText(o.hosts)}</hosts>`)
  if (o.port && String(o.port).trim()) parts.push(`<port>${escapeXmlText(o.port)}</port>`)
  if (o.severity !== undefined) parts.push(`<severity>${escapeXmlText(o.severity)}</severity>`)
  parts.push(`<new_severity>${escapeXmlText(o.newSeverity)}</new_severity>`)
  if (o.daysActive !== undefined) parts.push(`<active>${escapeXmlText(o.daysActive)}</active>`)
  if (o.taskId && String(o.taskId).trim()) parts.push(`<task id="${escapeXmlAttr(o.taskId)}"/>`)
  if (o.resultId && String(o.resultId).trim()) parts.push(`<result id="${escapeXmlAttr(o.resultId)}"/>`)
  return parts.join('')
}

export function buildCreateOverrideCommand(o: OverrideInput): string {
  return `<create_override>${buildOverrideBody(o)}</create_override>`
}

/** Always full resend — there is no partial-patch benefit for a resource with no stable natural key. */
export function buildModifyOverrideCommand(overrideId: string, o: OverrideInput): string {
  return `<modify_override override_id="${escapeXmlAttr(overrideId)}">${buildOverrideBody(o)}</modify_override>`
}

export function buildDeleteOverrideCommand(overrideId: string, ultimate = true): string {
  return `<delete_override override_id="${escapeXmlAttr(overrideId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpOverride {
  id: string
  text: string
  nvtOid: string
  hosts: string
  port: string
  severity: string
  newSeverity: string
  taskId: string
  resultId: string
}

/** Parse `<override id="…">…</override>` elements out of a get_overrides_response. */
export function parseOverrides(xml: string): GmpOverride[] {
  const out: GmpOverride[] = []
  const re = /<override\b([^>]*)>([\s\S]*?)<\/override>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    const nvtMatch = /<nvt\b([^>]*)\/?>/.exec(body)
    out.push({
      id,
      text: firstChildText(body, 'text') ?? '',
      nvtOid: nvtMatch ? (attrsFrom(nvtMatch[1]).oid ?? '') : '',
      hosts: firstChildText(body, 'hosts') ?? '',
      port: firstChildText(body, 'port') ?? '',
      severity: firstChildText(body, 'severity') ?? '',
      newSeverity: firstChildText(body, 'new_severity') ?? '',
      taskId: idAttrOf(body, 'task') ?? '',
      resultId: idAttrOf(body, 'result') ?? '',
    })
  }
  return out
}
