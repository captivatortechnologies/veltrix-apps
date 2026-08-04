// Shared helpers for the Greenbone Tags config type (deploy + rollback +
// drift). A tag is a name/value label attached to a set of resources of one
// resource type. Applied over GMP (XML over TLS). The tag NAME is the stable
// identity used to upsert (an app-level convention — gvmd itself allows
// duplicate tag names, see lib/gmp/tags.ts's FLAGS).

import type { TagInput, GmpTag } from '../../lib/gmp/tags'

export function buildTagInput(fields: Record<string, unknown>): TagInput {
  const resourceIds = Array.isArray(fields.resourceIds)
    ? fields.resourceIds.map((v) => String(v).trim()).filter(Boolean)
    : String(fields.resourceIds ?? '')
        .split(/[\s,]+/)
        .map((v) => v.trim())
        .filter(Boolean)
  return {
    name: String(fields.name ?? '').trim(),
    resourceType: String(fields.resourceType ?? '').trim() || 'task',
    resourceIds,
    value: String(fields.value ?? '').trim(),
    comment: String(fields.comment ?? '').trim(),
    active: fields.active !== false,
  }
}

/** Find a live tag by name (trimmed, case-sensitive — see the module-level "not unique" FLAG). */
export function findTagByName(tags: GmpTag[], name: string): GmpTag | null {
  const n = name.trim()
  if (!n) return null
  return tags.find((t) => t.name.trim() === n) ?? null
}
