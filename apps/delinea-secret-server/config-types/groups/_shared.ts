// Shared helpers for the Secret Server Groups config type (deploy + rollback +
// drift + health). Group shapes follow the Secret Server v1 REST API
// (/api/v1/groups).
//
// VERIFIED against the Delinea/Thycotic PowerShell module source
// (thycotic-ps/thycotic.secretserver — New/Get/Search-TssGroup):
//   search  GET  /api/v1/groups?filter.searchText=<text>&filter.includeInactive=true
//   read    GET  /api/v1/groups/{id}
//   create  POST /api/v1/groups   { name, enabled }
// Record keys: id / name / enabled / domainId / domainName / synchronized.
//
// FLAGGED — the PowerShell module exposes NO group UPDATE cmdlet, so the update
// verb + path is UNVERIFIED. This app updates an existing local group's `enabled`
// state via  PUT /api/v1/groups/{id}  (the dominant Secret Server convention for
// entity edits, e.g. secrets/folders). Verify against a live instance; a group
// synchronized from Directory Services is managed there, not here.

import {
  listAllRecords,
  normalizeBool,
  type SecretServerClient,
} from '../../lib/secretServerApi'

/** One group as returned by GET /api/v1/groups (record) or /api/v1/groups/{id}. */
export interface LiveGroup {
  id?: number | string
  name?: string
  enabled?: boolean
  domainId?: number | string
  domainName?: string
  synchronized?: boolean
  [key: string]: unknown
}

/** One group declared by a canvas item. */
export interface GroupSpec {
  groupName: string
  enabled: boolean
  comment: string
}

/** A canvas item shape (id/name optional; only fields are read). */
export interface CanvasItemLike {
  fields: Record<string, unknown>
}

export function groupNameOf(g: LiveGroup): string {
  return String(g.name ?? '')
}

/** A live group's numeric id, or null when absent / non-numeric. */
export function groupIdOf(g: LiveGroup): number | null {
  const raw = g.id
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** A group backed by Directory Services — managed there, not by this app. */
export function isSynchronizedGroup(g: LiveGroup): boolean {
  return normalizeBool(g.synchronized)
}

/** Map canvas items to group specs. */
export function extractGroupSpecs(items: CanvasItemLike[]): GroupSpec[] {
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      groupName: String(f.groupName ?? '').trim(),
      enabled: normalizeBool(f.enabled),
      comment: String(f.comment ?? '').trim(),
    }
  })
}

/**
 * Search groups, optionally filtered by name, across every page.
 * `filter.includeInactive=true` so an existing-but-disabled group is still
 * matched (upsert must find it). Throws on a non-OK response.
 */
export async function searchGroups(client: SecretServerClient, searchText?: string): Promise<LiveGroup[]> {
  const query: Record<string, string | number | boolean> = { 'filter.includeInactive': true }
  if (searchText) query['filter.searchText'] = searchText
  return listAllRecords<LiveGroup>(client, '/groups', query)
}

/** Find a live group by name (case-insensitive). */
export function findGroupByName(groups: LiveGroup[], name: string): LiveGroup | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return groups.find((g) => groupNameOf(g).trim().toLowerCase() === n) ?? null
}

/** Body for POST /api/v1/groups (create) — a local Secret Server group. */
export function buildGroupCreateBody(spec: GroupSpec): Record<string, unknown> {
  return { name: spec.groupName, enabled: spec.enabled }
}

/** Body for PUT /api/v1/groups/{id} (update the managed fields). Carries the id. */
export function buildGroupUpdateBody(spec: GroupSpec, existing: LiveGroup): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.groupName, enabled: spec.enabled }
  const id = groupIdOf(existing)
  if (id !== null) body.id = id
  return body
}

/** Restore body for a prior group — only the fields this app manages. */
export function buildGroupRestoreBody(prior: LiveGroup): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (prior.name !== undefined) body.name = prior.name
  if (prior.enabled !== undefined) body.enabled = normalizeBool(prior.enabled)
  if (prior.id !== undefined) body.id = prior.id
  return body
}
