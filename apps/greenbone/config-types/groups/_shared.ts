// Shared helpers for the Greenbone Groups config type (deploy + rollback +
// drift). A group is a named set of existing GMP users, usable as a
// permission subject. Applied over GMP (XML over TLS). The group NAME is the
// stable identity used to upsert — gvmd does not enforce unique names, so this
// app treats the name as the key (last one wins).

import type { GroupInput, GmpGroup } from '../../lib/gmp/groups'

export function buildGroupInput(fields: Record<string, unknown>): GroupInput {
  const users = Array.isArray(fields.users)
    ? fields.users.map((v) => String(v).trim()).filter(Boolean)
    : String(fields.users ?? '')
        .split(/[\s,]+/)
        .map((v) => v.trim())
        .filter(Boolean)
  return {
    name: String(fields.name ?? '').trim(),
    comment: String(fields.comment ?? '').trim(),
    users,
    specialsFull: fields.specialsFull === true,
  }
}

/** Find a live group by name (trimmed, case-sensitive). */
export function findGroupByName(groups: GmpGroup[], name: string): GmpGroup | null {
  const n = name.trim()
  if (!n) return null
  return groups.find((g) => g.name.trim() === n) ?? null
}
