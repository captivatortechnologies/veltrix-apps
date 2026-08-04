// =============================================================================
// GMP entity — Filters (<create_filter>/<get_filters>/<modify_filter>/
// <delete_filter>). A named, reusable search filter (a GMP filter TERM string
// scoped to a resource type) that other GMP list views/UI pages can select.
// Built on the transport + wire-format primitives in ../greenboneApi.ts.
//
// Verified against the GMP 22.5 command reference (cite):
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_create_filter
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_modify_filter
// and python-gvm's request builders (gvm/protocols/gmp/requests/v224/_filters.py,
// FilterType enum).
//
// FLAGS:
//   * `type` is plain text in the RNC (not a protocol-enforced enum) — the
//     FILTER_TYPES list below is python-gvm's client-side convenience enum
//     (best-known values), not a guaranteed-exhaustive or forward-compatible
//     set.
//   * Fully mutable via modify_filter — no immutability quirks found.
//   * ultimate=1 on delete is GMP's general trashcan bypass, applied
//     consistently with every other delete_* in this app.
// =============================================================================

import { attrsFrom, firstChildText, escapeXmlAttr, escapeXmlText } from '../greenboneApi'

/** python-gvm FilterType enum — best-known resource types a filter can scope to (not protocol-enforced). */
export const FILTER_TYPES = [
  'alert', 'asset', 'config', 'credential', 'filter', 'group', 'host', 'note', 'os', 'override',
  'permission', 'port_list', 'report', 'report_format', 'result', 'role', 'schedule', 'secinfo',
  'tag', 'target', 'task', 'ticket', 'tls_certificate', 'user', 'vuln',
] as const

export function buildGetFiltersCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_filters filter="${escapeXmlAttr(filter)}"/>`
}

export interface FilterInput {
  name: string
  type?: string
  term?: string
  comment?: string
}

export function buildCreateFilterCommand(f: FilterInput): string {
  const parts = [`<name>${escapeXmlText(f.name)}</name>`]
  if (f.term !== undefined) parts.push(`<term>${escapeXmlText(f.term)}</term>`)
  if (f.type && String(f.type).trim()) parts.push(`<type>${escapeXmlText(f.type)}</type>`)
  if (f.comment && String(f.comment).trim()) parts.push(`<comment>${escapeXmlText(f.comment)}</comment>`)
  return `<create_filter>${parts.join('')}</create_filter>`
}

export function buildModifyFilterCommand(filterId: string, f: { name?: string; type?: string; term?: string; comment?: string }): string {
  const parts: string[] = []
  if (f.name !== undefined) parts.push(`<name>${escapeXmlText(f.name)}</name>`)
  if (f.term !== undefined) parts.push(`<term>${escapeXmlText(f.term)}</term>`)
  if (f.type !== undefined) parts.push(`<type>${escapeXmlText(f.type)}</type>`)
  if (f.comment !== undefined) parts.push(`<comment>${escapeXmlText(f.comment)}</comment>`)
  return `<modify_filter filter_id="${escapeXmlAttr(filterId)}">${parts.join('')}</modify_filter>`
}

export function buildDeleteFilterCommand(filterId: string, ultimate = true): string {
  return `<delete_filter filter_id="${escapeXmlAttr(filterId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpFilter {
  id: string
  name: string
  comment: string
  type: string
  term: string
}

/** Parse `<filter id="…">…</filter>` elements out of a get_filters_response. */
export function parseFilters(xml: string): GmpFilter[] {
  const out: GmpFilter[] = []
  const re = /<filter\b([^>]*)>([\s\S]*?)<\/filter>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    out.push({
      id,
      name: firstChildText(body, 'name') ?? '',
      comment: firstChildText(body, 'comment') ?? '',
      type: firstChildText(body, 'type') ?? '',
      term: firstChildText(body, 'term') ?? '',
    })
  }
  return out
}
