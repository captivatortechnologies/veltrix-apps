// =============================================================================
// GMP entity — Groups (<create_group>/<get_groups>/<modify_group>/
// <delete_group>). A named group of existing GMP users, usable as a
// permission subject. Built on the transport + wire-format primitives in
// ../greenboneApi.ts.
//
// Verified against the GMP 22.5 command reference (cite):
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_create_group
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_modify_group
// and python-gvm's request builders (gvm/protocols/gmp/requests/v224/_groups.py).
//
// FLAGS — verify against a live gvmd (GMP is version-specific):
//   * `users` is a COMMA-SEPARATED STRING OF EXISTING USERNAMES (not ids) —
//     `create_group_users = element users { text }`. gvmd's behavior on an
//     unknown username is not documented; a bad username surfaces whatever
//     error gvmd returns rather than being pre-validated here (this app does
//     not manage GMP users).
//   * `specials/full` ("give every member full mutual access to each other's
//     entities") is CREATE-ONLY — modify_group's RNC has no `specials` field
//     at all. Once set at creation, it cannot be changed via modify; changing
//     it declared-vs-live is surfaced as a deploy note (mirrors port-lists'
//     "range is immutable via modify" pattern) rather than silently ignored.
//   * ultimate=1 on delete is GMP's general trashcan bypass, applied
//     consistently with every other delete_* in this app.
// =============================================================================

import { attrsFrom, firstChildText, escapeXmlAttr, escapeXmlText } from '../greenboneApi'

export function buildGetGroupsCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_groups filter="${escapeXmlAttr(filter)}"/>`
}

export interface GroupInput {
  name: string
  comment?: string
  users?: string[]
  /** create-only — see FLAGS. */
  specialsFull?: boolean
}

export function buildCreateGroupCommand(g: GroupInput): string {
  const parts = [`<name>${escapeXmlText(g.name)}</name>`]
  if (g.comment && String(g.comment).trim()) parts.push(`<comment>${escapeXmlText(g.comment)}</comment>`)
  if (g.users !== undefined) parts.push(`<users>${escapeXmlText(g.users.join(', '))}</users>`)
  if (g.specialsFull) parts.push('<specials><full/></specials>')
  return `<create_group>${parts.join('')}</create_group>`
}

/** No `specials` field — modify_group cannot change the create-only "full access" flag (see FLAGS). */
export function buildModifyGroupCommand(groupId: string, g: { name?: string; comment?: string; users?: string[] }): string {
  const parts: string[] = []
  if (g.name !== undefined) parts.push(`<name>${escapeXmlText(g.name)}</name>`)
  if (g.comment !== undefined) parts.push(`<comment>${escapeXmlText(g.comment)}</comment>`)
  if (g.users !== undefined) parts.push(`<users>${escapeXmlText(g.users.join(', '))}</users>`)
  return `<modify_group group_id="${escapeXmlAttr(groupId)}">${parts.join('')}</modify_group>`
}

export function buildDeleteGroupCommand(groupId: string, ultimate = true): string {
  return `<delete_group group_id="${escapeXmlAttr(groupId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpGroup {
  id: string
  name: string
  comment: string
  users: string[]
  specialsFull: boolean
}

/** Parse `<group id="…">…</group>` elements out of a get_groups_response. */
export function parseGroups(xml: string): GmpGroup[] {
  const out: GmpGroup[] = []
  const re = /<group\b([^>]*)>([\s\S]*?)<\/group>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    const usersText = firstChildText(body, 'users') ?? ''
    out.push({
      id,
      name: firstChildText(body, 'name') ?? '',
      comment: firstChildText(body, 'comment') ?? '',
      users: usersText
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean),
      specialsFull: /<specials>\s*<full\s*\/>\s*<\/specials>/.test(body),
    })
  }
  return out
}
