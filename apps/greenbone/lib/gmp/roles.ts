// =============================================================================
// GMP entity — Roles (<create_role>/<get_roles>/<modify_role>/<delete_role>).
// A named role a user/group can hold; permissions attach to a role only via
// the SEPARATE create_permission command (see ./permissions.ts) — GMP 22.x's
// create_role/modify_role carry no permission list of their own. Built on the
// transport + wire-format primitives in ../greenboneApi.ts.
//
// Verified against the GMP 22.5 command reference (cite):
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_create_role
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_get_roles
// and python-gvm's request builders (gvm/protocols/gmp/requests/v224/_roles.py,
// which has no permission-related parameters, confirming the split from
// create_permission).
//
// FLAGS:
//   * PREDEFINED ROLES: the GMP 22.5 protocol doc itself does not enumerate
//     the built-in roles. The authoritative list below is read directly from
//     gvmd server source (src/manage_sql.h's role UUID #defines, seeded in
//     src/manage_sql.c) — 7 fixed, protected roles with stable UUIDs across
//     every gvmd install. This app never attempts to create/modify/delete a
//     role matching one of these UUIDs (or names) — a declared item that
//     collides with a predefined role name is skipped with a validation
//     warning rather than attempting a doomed write. (get_roles' `<writable>`
//     flag is the doc-confirmed general "can this be changed" signal for any
//     GMP resource, but the specific modify/delete-rejection code path for
//     roles was not directly located in the fetched gvmd source — treat
//     "predefined roles reject modify/delete" as high-confidence, not
//     byte-for-byte quote-verified.)
//   * `users` is a comma-separated string of existing usernames (not ids) —
//     same shape and same "gvmd's behavior on an unknown username is
//     undocumented" caveat as groups (see ./groups.ts).
//   * ultimate=1 on delete is GMP's general trashcan bypass, applied
//     consistently with every other delete_* in this app.
// =============================================================================

import { attrsFrom, firstChildText, escapeXmlAttr, escapeXmlText } from '../greenboneApi'

/** The 7 predefined/protected GMP roles — gvmd/src/manage_sql.h UUID #defines. Never create/modify/delete these. */
export const PREDEFINED_ROLES: ReadonlyArray<{ name: string; id: string }> = [
  { name: 'Admin', id: '7a8cb5b4-b74d-11e2-8187-406186ea4fc5' },
  { name: 'User', id: '8d453140-b74d-11e2-b0be-406186ea4fc5' },
  { name: 'Observer', id: '87a7ebce-b74d-11e2-a81f-406186ea4fc5' },
  { name: 'Guest', id: 'cc9cac5e-39a3-11e4-abae-406186ea4fc5' },
  { name: 'Info', id: '5f8fd16c-c550-11e3-b6ab-406186ea4fc5' },
  { name: 'Monitor', id: '12cdb536-480b-11e4-8552-406186ea4fc5' },
  { name: 'Super Admin', id: '9c5a6ec6-6fe2-11e4-8cb6-406186ea4fc5' },
]

export const PREDEFINED_ROLE_IDS: ReadonlySet<string> = new Set(PREDEFINED_ROLES.map((r) => r.id))
export const PREDEFINED_ROLE_NAMES: ReadonlySet<string> = new Set(PREDEFINED_ROLES.map((r) => r.name))

export function buildGetRolesCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_roles filter="${escapeXmlAttr(filter)}"/>`
}

export interface RoleInput {
  name: string
  comment?: string
  users?: string[]
}

export function buildCreateRoleCommand(r: RoleInput): string {
  const parts = [`<name>${escapeXmlText(r.name)}</name>`]
  if (r.comment && String(r.comment).trim()) parts.push(`<comment>${escapeXmlText(r.comment)}</comment>`)
  if (r.users !== undefined) parts.push(`<users>${escapeXmlText(r.users.join(', '))}</users>`)
  return `<create_role>${parts.join('')}</create_role>`
}

export function buildModifyRoleCommand(roleId: string, r: { name?: string; comment?: string; users?: string[] }): string {
  const parts: string[] = []
  if (r.name !== undefined) parts.push(`<name>${escapeXmlText(r.name)}</name>`)
  if (r.comment !== undefined) parts.push(`<comment>${escapeXmlText(r.comment)}</comment>`)
  if (r.users !== undefined) parts.push(`<users>${escapeXmlText(r.users.join(', '))}</users>`)
  return `<modify_role role_id="${escapeXmlAttr(roleId)}">${parts.join('')}</modify_role>`
}

export function buildDeleteRoleCommand(roleId: string, ultimate = true): string {
  return `<delete_role role_id="${escapeXmlAttr(roleId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpRole {
  id: string
  name: string
  comment: string
  users: string[]
}

/** Parse `<role id="…">…</role>` elements out of a get_roles_response. */
export function parseRoles(xml: string): GmpRole[] {
  const out: GmpRole[] = []
  const re = /<role\b([^>]*)>([\s\S]*?)<\/role>/g
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
    })
  }
  return out
}
