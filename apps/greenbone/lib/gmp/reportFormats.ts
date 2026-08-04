// =============================================================================
// GMP entity — Report Formats (<create_report_format>/<get_report_formats>/
// <modify_report_format>/<delete_report_format>). Scoped strictly to CLONING
// an existing (usually predefined) report format and toggling its
// active/name/summary/param values — never installing new generation code.
// Built on the transport + wire-format primitives in ../greenboneApi.ts.
//
// Verified against the GMP 22.5 command reference (cite):
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_create_report_format
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_modify_report_format
// and python-gvm's request builders (gvm/protocols/gmp/requests/v224/_report_formats.py
// — which has no "author from scratch" helper, only clone_report_format(copy)
// and import_report_format(raw exported XML replay)).
//
// FLAGS — DELIBERATE SCOPE LIMIT (security):
//   * create_report_format's schema is `(copy | get_report_formats_response)`
//     — the SECOND form is a raw replay of an EXPORTED report format, which
//     (per get_report_formats with details=1) carries a base64 `<file>`
//     element containing the actual report-GENERATION SCRIPT (XSLT/Python) —
//     i.e. that path installs executable code server-side. This app ONLY
//     ever uses the `<copy>` clone form; the raw-file-import path is never
//     exposed through this config type (matches the platform's "no
//     executables" posture for app-shipped code, applied here to
//     tenant-declared config too).
//   * create_report_format via <copy> takes ONLY a base UUID — no <name> in
//     the same call (confirmed: the doc's own create example is
//     `<create_report_format><copy>UUID</copy></create_report_format>`, no
//     sibling <name>). A rename after cloning needs a FOLLOW-UP
//     modify_report_format call — the deploy handler does exactly that.
//   * modify_report_format only accepts active/name/summary/param — it CANNOT
//     add new params or touch the generation script, matching the scope above.
//     `param/value` is base64 (see encodeGmpValue in ../greenboneApi.ts).
//   * verify_report_format (a feed-signature integrity check) is a runtime
//     action, not config — intentionally not wired to anything here.
//   * ultimate=1 on delete is GMP's general trashcan bypass, applied
//     consistently with every other delete_* in this app. Predefined formats
//     are typically protected (like predefined roles) — deploy only ever
//     attempts delete on a format THIS app created via clone (see
//     config-types/report-formats/deploy.ts).
// =============================================================================

import { attrsFrom, firstChildText, encodeGmpValue, decodeGmpValue, escapeXmlAttr, escapeXmlText } from '../greenboneApi'

export function buildGetReportFormatsCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_report_formats filter="${escapeXmlAttr(filter)}"/>`
}

/** Clone-only create — see FLAGS. The new id comes back on the response (parseCreatedId). */
export function buildCreateReportFormatCommand(cloneFrom: string): string {
  return `<create_report_format><copy>${escapeXmlText(cloneFrom)}</copy></create_report_format>`
}

export interface ReportFormatParam {
  name: string
  value: string
}

export interface ReportFormatModifyInput {
  name?: string
  summary?: string
  active?: boolean
  params?: ReportFormatParam[]
}

export function buildModifyReportFormatCommand(reportFormatId: string, r: ReportFormatModifyInput): string {
  const parts: string[] = []
  if (r.active !== undefined) parts.push(`<active>${r.active ? 1 : 0}</active>`)
  if (r.name !== undefined) parts.push(`<name>${escapeXmlText(r.name)}</name>`)
  if (r.summary !== undefined) parts.push(`<summary>${escapeXmlText(r.summary)}</summary>`)
  for (const p of r.params ?? []) {
    parts.push(`<param><name>${escapeXmlText(p.name)}</name><value>${encodeGmpValue(p.value)}</value></param>`)
  }
  return `<modify_report_format report_format_id="${escapeXmlAttr(reportFormatId)}">${parts.join('')}</modify_report_format>`
}

export function buildDeleteReportFormatCommand(reportFormatId: string, ultimate = true): string {
  return `<delete_report_format report_format_id="${escapeXmlAttr(reportFormatId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpReportFormat {
  id: string
  name: string
  comment: string
  summary: string
  active: boolean
  params: Record<string, string>
}

/** Parse `<report_format id="…">…</report_format>` elements out of a get_report_formats_response. */
export function parseReportFormats(xml: string): GmpReportFormat[] {
  const out: GmpReportFormat[] = []
  const re = /<report_format\b([^>]*)>([\s\S]*?)<\/report_format>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    const params: Record<string, string> = {}
    const paramRe = /<param\b[^>]*>([\s\S]*?)<\/param>/g
    let pm: RegExpExecArray | null
    while ((pm = paramRe.exec(body))) {
      const name = firstChildText(pm[1], 'name')
      const value = firstChildText(pm[1], 'value')
      if (name) params[name] = decodeGmpValue(value ?? '')
    }
    out.push({
      id,
      name: firstChildText(body, 'name') ?? '',
      comment: firstChildText(body, 'comment') ?? '',
      summary: firstChildText(body, 'summary') ?? '',
      active: (firstChildText(body, 'active') ?? '1') === '1',
      params,
    })
  }
  return out
}
