// =============================================================================
// GMP entity — Notes (<create_note>/<get_notes>/<modify_note>/<delete_note>).
// A persistent, re-appliable comment attached to a specific NVT's results
// (no severity change — see ./overrides.ts for that), optionally scoped to
// hosts/port/task/result. Built on the transport + wire-format primitives in
// ../greenboneApi.ts.
//
// Verified against the GMP 22.5 command reference's <note> response element
// (cite): https://docs.greenbone.net/API/GMP/gmp-22.5.html#element_note
// and python-gvm's request builders (gvm/protocols/gmp/requests/v224/_notes.py
// — Notes.create_note/modify_note drop severity/new_severity relative to
// Overrides, confirming notes are structurally overrides minus the severity
// fields).
//
// FLAGS — same as ./overrides.ts:
//   * NO NATURAL NAME — identity is tracked by the CANVAS ITEM's own stable
//     id (pfsense/static-routes pattern), not by matching content.
//   * `active` (days-count on write) is not diffed in drift — see
//     ./overrides.ts's FLAG; always re-applied as declared.
//   * ultimate=1 on delete is GMP's general trashcan bypass, applied
//     consistently with every other delete_* in this app.
// =============================================================================

import { attrsFrom, firstChildText, idAttrOf, escapeXmlAttr, escapeXmlText } from '../greenboneApi'

export function buildGetNotesCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_notes filter="${escapeXmlAttr(filter)}"/>`
}

export interface NoteInput {
  text: string
  nvtOid: string
  hosts?: string
  port?: string
  daysActive?: number
  taskId?: string
  resultId?: string
}

function buildNoteBody(n: NoteInput): string {
  const parts = [`<text>${escapeXmlText(n.text)}</text>`, `<nvt oid="${escapeXmlAttr(n.nvtOid)}"/>`]
  if (n.hosts && String(n.hosts).trim()) parts.push(`<hosts>${escapeXmlText(n.hosts)}</hosts>`)
  if (n.port && String(n.port).trim()) parts.push(`<port>${escapeXmlText(n.port)}</port>`)
  if (n.daysActive !== undefined) parts.push(`<active>${escapeXmlText(n.daysActive)}</active>`)
  if (n.taskId && String(n.taskId).trim()) parts.push(`<task id="${escapeXmlAttr(n.taskId)}"/>`)
  if (n.resultId && String(n.resultId).trim()) parts.push(`<result id="${escapeXmlAttr(n.resultId)}"/>`)
  return parts.join('')
}

export function buildCreateNoteCommand(n: NoteInput): string {
  return `<create_note>${buildNoteBody(n)}</create_note>`
}

export function buildModifyNoteCommand(noteId: string, n: NoteInput): string {
  return `<modify_note note_id="${escapeXmlAttr(noteId)}">${buildNoteBody(n)}</modify_note>`
}

export function buildDeleteNoteCommand(noteId: string, ultimate = true): string {
  return `<delete_note note_id="${escapeXmlAttr(noteId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpNote {
  id: string
  text: string
  nvtOid: string
  hosts: string
  port: string
  taskId: string
  resultId: string
}

/** Parse `<note id="…">…</note>` elements out of a get_notes_response. */
export function parseNotes(xml: string): GmpNote[] {
  const out: GmpNote[] = []
  const re = /<note\b([^>]*)>([\s\S]*?)<\/note>/g
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
      taskId: idAttrOf(body, 'task') ?? '',
      resultId: idAttrOf(body, 'result') ?? '',
    })
  }
  return out
}
