// =============================================================================
// GMP entity — Permissions (<create_permission>/<get_permissions>/
// <modify_permission>/<delete_permission>). Grants ONE capability (a GMP
// command name, e.g. "get_tasks"/"create_task", or the special "Super") to a
// subject (user/group/role), optionally scoped to one resource. Built on the
// transport + wire-format primitives in ../greenboneApi.ts.
//
// Verified against the GMP 22.5 command reference (cite):
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_create_permission
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_modify_permission
// and python-gvm's request builders (gvm/protocols/gmp/requests/v224/_permissions.py,
// PermissionSubjectType enum).
//
// FLAGS:
//   * NO NATURAL NAME: a permission's `name` field is the granted COMMAND
//     name, not a user-chosen label, and (name, subject, resource) is not
//     enforced unique by gvmd — many permissions can legitimately share a
//     `name`. Unlike targets/schedules/etc., this config type therefore
//     tracks identity by the CANVAS ITEM's own stable id (the same pattern
//     apps/pfsense/config-types/static-routes uses for a resource with no
//     name field), NOT by matching declared vs. live entities on content.
//   * "Super" permission: confirmed as a recognized special `name` value by
//     the doc's OWN field description for resource/type ("GMP type, for Super
//     permissions: user, group or role") but the literal string "Super" does
//     not appear verbatim elsewhere on the 22.5 page — corroborated by
//     python-gvm's docstrings, not fully primary-source-confirmed. Flagged,
//     not blocked: this app accepts any `name` value as declared.
//   * ultimate=1 on delete is GMP's general trashcan bypass, applied
//     consistently with every other delete_* in this app.
// =============================================================================

import { attrsFrom, firstChildText, idAttrOf, escapeXmlAttr, escapeXmlText } from '../greenboneApi'

export const PERMISSION_SUBJECT_TYPES = ['user', 'group', 'role'] as const

export function buildGetPermissionsCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_permissions filter="${escapeXmlAttr(filter)}"/>`
}

export interface PermissionInput {
  name: string
  subjectId: string
  subjectType: string
  resourceId?: string
  resourceType?: string
  comment?: string
}

function buildSubjectAndResource(p: PermissionInput): string {
  let out = `<subject id="${escapeXmlAttr(p.subjectId)}"><type>${escapeXmlText(p.subjectType)}</type></subject>`
  if (p.resourceId && String(p.resourceId).trim()) {
    out += `<resource id="${escapeXmlAttr(p.resourceId)}"><type>${escapeXmlText(p.resourceType ?? '')}</type></resource>`
  }
  return out
}

export function buildCreatePermissionCommand(p: PermissionInput): string {
  const parts = [`<name>${escapeXmlText(p.name)}</name>`, buildSubjectAndResource(p)]
  if (p.comment && String(p.comment).trim()) parts.push(`<comment>${escapeXmlText(p.comment)}</comment>`)
  return `<create_permission>${parts.join('')}</create_permission>`
}

export function buildModifyPermissionCommand(permissionId: string, p: PermissionInput): string {
  const parts = [`<name>${escapeXmlText(p.name)}</name>`, buildSubjectAndResource(p)]
  if (p.comment !== undefined) parts.push(`<comment>${escapeXmlText(p.comment)}</comment>`)
  return `<modify_permission permission_id="${escapeXmlAttr(permissionId)}">${parts.join('')}</modify_permission>`
}

export function buildDeletePermissionCommand(permissionId: string, ultimate = true): string {
  return `<delete_permission permission_id="${escapeXmlAttr(permissionId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpPermission {
  id: string
  name: string
  comment: string
  subjectId: string
  subjectType: string
  resourceId: string
  resourceType: string
}

/** Parse `<permission id="…">…</permission>` elements out of a get_permissions_response. */
export function parsePermissions(xml: string): GmpPermission[] {
  const out: GmpPermission[] = []
  const re = /<permission\b([^>]*)>([\s\S]*?)<\/permission>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    const subjectMatch = /<subject\b[^>]*>([\s\S]*?)<\/subject>/.exec(body)
    const resourceMatch = /<resource\b[^>]*>([\s\S]*?)<\/resource>/.exec(body)
    out.push({
      id,
      name: firstChildText(body, 'name') ?? '',
      comment: firstChildText(body, 'comment') ?? '',
      subjectId: idAttrOf(body, 'subject') ?? '',
      subjectType: subjectMatch ? (firstChildText(subjectMatch[1], 'type') ?? '') : '',
      resourceId: idAttrOf(body, 'resource') ?? '',
      resourceType: resourceMatch ? (firstChildText(resourceMatch[1], 'type') ?? '') : '',
    })
  }
  return out
}
