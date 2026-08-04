// =============================================================================
// GMP entity — Tags (<create_tag>/<get_tags>/<modify_tag>/<delete_tag>). A
// name/value label attachable to a set of resources of one GMP resource type.
// Built on the transport + wire-format primitives in ../greenboneApi.ts.
//
// Verified against the GMP 22.5 command reference (cite):
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_create_tag
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_modify_tag
// and python-gvm's request builders (gvm/protocols/gmp/requests/v224/_tags.py).
//
// FLAGS — verify against a live gvmd (GMP is version-specific):
//   * RESOURCE-ATTACHMENT SHAPE: the doc's own create_tag PROSE describes a
//     required `resources` element containing a `type` child plus either a
//     `filter` attribute or repeatable `<resource id="…"/>` children — but a
//     doc EXAMPLE elsewhere shows a shorthand singular `<resource
//     id="…"><type>target</type></resource>` with no plural wrapper. This app
//     uses the `<resources><type/>…<resource id/>…</resources>` wrapper form
//     (matching python-gvm's actual, tested request builder — higher
//     confidence than a possibly-abbreviated doc snippet) since it is the only
//     form that cleanly supports the zero/one/many-resource cases this canvas
//     needs. `modify_tag`'s `resources/@action` ("add"/"set"/"remove") is
//     doc-confirmed; this app always sends `action="set"` (full replace) so a
//     redeploy is idempotent regardless of what was attached out-of-band.
//   * NAMES ARE NOT UNIQUE: gvmd allows multiple tags with the same name
//     (unlike targets/schedules where this app treats name as a de-facto key
//     purely as an app convention) — this app follows the SAME "last one wins
//     on a duplicate declared name" convention already used by every other
//     name-based Greenbone config type for consistency, though the underlying
//     tool enforces even less uniqueness here than there.
//   * DRIFT ON RESOURCE ATTACHMENT: get_tags' exact response shape for the
//     attached resource id list is not independently verified here (it may
//     differ from the create/modify wire shape, the way port_list's read shape
//     differs from its write shape) — drift therefore compares name/value/
//     comment/active only, NOT the attached resource id list. Every deploy
//     unconditionally re-applies the declared resourceIds via `action="set"`.
//   * ultimate=1 on delete is GMP's general trashcan bypass, applied
//     consistently with every other delete_* in this app.
// =============================================================================

import { attrsFrom, firstChildText, escapeXmlAttr, escapeXmlText } from '../greenboneApi'

export function buildGetTagsCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_tags filter="${escapeXmlAttr(filter)}"/>`
}

export interface TagInput {
  name: string
  resourceType: string
  resourceIds: string[]
  value?: string
  comment?: string
  active?: boolean
}

function buildResourcesElement(resourceType: string, resourceIds: string[], action?: 'set'): string {
  const attr = action ? ` action="${action}"` : ''
  const refs = resourceIds.map((id) => `<resource id="${escapeXmlAttr(id)}"/>`).join('')
  return `<resources${attr}><type>${escapeXmlText(resourceType)}</type>${refs}</resources>`
}

export function buildCreateTagCommand(t: TagInput): string {
  const parts = [`<name>${escapeXmlText(t.name)}</name>`, buildResourcesElement(t.resourceType, t.resourceIds)]
  if (t.value !== undefined) parts.push(`<value>${escapeXmlText(t.value)}</value>`)
  if (t.comment && String(t.comment).trim()) parts.push(`<comment>${escapeXmlText(t.comment)}</comment>`)
  if (t.active !== undefined) parts.push(`<active>${t.active ? 1 : 0}</active>`)
  return `<create_tag>${parts.join('')}</create_tag>`
}

/** Always sends resources with action="set" (full replace) — see FLAGS. */
export function buildModifyTagCommand(tagId: string, t: TagInput): string {
  const parts = [`<name>${escapeXmlText(t.name)}</name>`, buildResourcesElement(t.resourceType, t.resourceIds, 'set')]
  if (t.value !== undefined) parts.push(`<value>${escapeXmlText(t.value)}</value>`)
  if (t.comment !== undefined) parts.push(`<comment>${escapeXmlText(t.comment)}</comment>`)
  if (t.active !== undefined) parts.push(`<active>${t.active ? 1 : 0}</active>`)
  return `<modify_tag tag_id="${escapeXmlAttr(tagId)}">${parts.join('')}</modify_tag>`
}

export function buildDeleteTagCommand(tagId: string, ultimate = true): string {
  return `<delete_tag tag_id="${escapeXmlAttr(tagId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpTag {
  id: string
  name: string
  comment: string
  value: string
  active: boolean
  resourceType: string
}

/** Parse `<tag id="…">…</tag>` elements out of a get_tags_response (name/value/comment/active/resourceType only — see FLAGS on resource-attachment drift). */
export function parseTags(xml: string): GmpTag[] {
  const out: GmpTag[] = []
  const re = /<tag\b([^>]*)>([\s\S]*?)<\/tag>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    const resourcesMatch = /<resources\b[^>]*>([\s\S]*?)<\/resources>/.exec(body)
    out.push({
      id,
      name: firstChildText(body, 'name') ?? '',
      comment: firstChildText(body, 'comment') ?? '',
      value: firstChildText(body, 'value') ?? '',
      active: (firstChildText(body, 'active') ?? '1') === '1',
      resourceType: resourcesMatch ? (firstChildText(resourcesMatch[1], 'type') ?? '') : '',
    })
  }
  return out
}
