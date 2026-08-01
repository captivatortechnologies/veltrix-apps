// =============================================================================
// Generic Tanium REST v2 "named entity" adapter.
//
// Every top-level Tanium REST v2 object (saved_questions, packages, groups,
// saved_actions, sensors, action_groups, ...) shares the same URL shape:
//   list        GET    /api/v2/<resource>
//   by name     GET    /api/v2/<resource>/by-name/<name>
//   by id       GET    /api/v2/<resource>/<id>
//   create      POST   /api/v2/<resource>
//   delete      DELETE /api/v2/<resource>/<id>
// and wraps payloads in a `{ data: ... }` envelope. This module centralises
// those verbs on top of the session:-header client in lib/taniumApi.ts so each
// config type only declares its object shape + body builder.
//
// VERIFY AGAINST A LIVE TANIUM: list / by-name / by-id / POST-create are exercised
// by Tanium's public integrations (Cortex XSOAR Tanium_v2, Splunk SOAR
// taniumrest). REST v2 offers no confirmed in-place PUT/PATCH for these objects,
// so callers upsert by DELETE + POST (recreate). DELETE /api/v2/<resource>/<id>
// follows REST v2 convention (same posture as the computer-groups config type).
// =============================================================================

import { getJson, sendJson, taniumRequest, sessionHeader } from './taniumApi'

/** A Tanium REST object with the stable `name` identity used for upsert + drift. */
export interface NamedEntity {
  id?: number | string
  name?: string
  [key: string]: unknown
}

/** Unwrap a REST response that may nest its payload in a `{ data: ... }` envelope. */
export function unwrapData(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data
  }
  return body
}

/**
 * Coerce a Tanium list response into a flat array. Handles `[...]`,
 * `{ data: [...] }`, and `{ data: { <collectionKey>: [...] } }` (some builds
 * wrap the collection under the pluralised resource key, e.g. `saved_questions`).
 */
export function arrayFrom(body: unknown, collectionKey?: string): unknown[] {
  const data = unwrapData(body)
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (collectionKey && Array.isArray(obj[collectionKey])) return obj[collectionKey] as unknown[]
    for (const value of Object.values(obj)) if (Array.isArray(value)) return value
  }
  return []
}

/** Unwrap a single-object response (`{ data: {...} }` or a bare object). */
export function objectFrom<T extends NamedEntity>(body: unknown): T | null {
  const data = unwrapData(body)
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as T) : null
}

/** Find a live object by name, case-insensitively — the identity for upsert + drift. */
export function findByName<T extends NamedEntity>(items: T[], name: string): T | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return items.find((it) => String(it.name ?? '').trim().toLowerCase() === n) ?? null
}

/** List every object of a resource. Best-effort: an unreadable list yields `[]`. */
export async function listEntities<T extends NamedEntity>(
  base: string,
  session: string,
  resource: string,
  collectionKey?: string,
): Promise<T[]> {
  try {
    return arrayFrom(await getJson<unknown>(`${base}/${resource}`, session), collectionKey) as T[]
  } catch {
    return []
  }
}

/**
 * Look up a single object by name. A 404 (no such object) resolves to `null`; any
 * other non-2xx throws so callers surface the error. GET /api/v2/<resource>/by-name/<name>.
 */
export async function getEntityByName<T extends NamedEntity>(
  base: string,
  session: string,
  resource: string,
  name: string,
): Promise<T | null> {
  const res = await taniumRequest(`${base}/${resource}/by-name/${encodeURIComponent(name)}`, {
    headers: sessionHeader(session),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${resource}/by-name/${name} → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  return objectFrom<T>(JSON.parse(res.body || '{}'))
}

/** Create an object. POST /api/v2/<resource>; returns the created object (unwrapped). */
export async function createEntity<T extends NamedEntity>(
  base: string,
  session: string,
  resource: string,
  body: unknown,
): Promise<T | null> {
  return objectFrom<T>(await sendJson<unknown>('POST', `${base}/${resource}`, session, body))
}

/** Delete an object by id. DELETE /api/v2/<resource>/<id>. */
export async function deleteEntity(
  base: string,
  session: string,
  resource: string,
  id: number | string,
): Promise<void> {
  await sendJson('DELETE', `${base}/${resource}/${encodeURIComponent(String(id))}`, session)
}

/**
 * One rollback record per deployed item, written by upsertEntity() and consumed by
 * rollbackEntity(): the prior object (null when the item did not exist before), its
 * id, and the id of the object this deploy created.
 */
export interface UpsertRecord<T extends NamedEntity> {
  name: string
  priorId: number | string | null
  prior: T | null
  newId: number | string | null
}

/**
 * Upsert one object by name via delete + recreate (REST v2 exposes no confirmed
 * in-place update for these objects):
 *   exists  → DELETE the prior, then POST the new body; record the prior for rollback.
 *   missing → POST the new body; record prior = null.
 */
export async function upsertEntity<T extends NamedEntity>(
  base: string,
  session: string,
  resource: string,
  name: string,
  body: unknown,
): Promise<UpsertRecord<T>> {
  const existing = await getEntityByName<T>(base, session, resource, name)
  if (existing?.id != null) {
    await deleteEntity(base, session, resource, existing.id)
    const created = await createEntity<T>(base, session, resource, body)
    return { name, priorId: existing.id, prior: existing, newId: created?.id ?? null }
  }
  const created = await createEntity<T>(base, session, resource, body)
  return { name, priorId: null, prior: null, newId: created?.id ?? null }
}

/**
 * Undo one upsert: delete the object this deploy created (by recorded id, or by
 * name when the id was never learned), then recreate the prior object when there
 * was one. `restoreBody` rebuilds the POST body from the captured prior object.
 * Returns what happened for the rollback summary.
 */
export async function rollbackEntity<T extends NamedEntity>(
  base: string,
  session: string,
  resource: string,
  record: UpsertRecord<T>,
  restoreBody: (prior: T) => unknown,
): Promise<'restored' | 'deleted' | 'left'> {
  let currentId = record.newId
  if (currentId == null) {
    const current = await getEntityByName<T>(base, session, resource, record.name)
    currentId = current?.id ?? null
  }
  if (currentId != null) await deleteEntity(base, session, resource, currentId)
  if (record.prior) {
    await createEntity(base, session, resource, restoreBody(record.prior))
    return 'restored'
  }
  return currentId != null ? 'deleted' : 'left'
}
