// =============================================================================
// Cortex XSOAR Classifiers & Mappers — shared plumbing.
//
// Classifiers and (incoming/outgoing) mappers are the SAME underlying server
// object, distinguished only by their `type`: "classification" for a
// classifier, "mapping-incoming" / "mapping-outgoing" for a mapper (confirmed
// against real content — e.g. a shipped classifier declares
// `"type": "classification"`, a shipped incoming mapper
// `"type": "mapping-incoming"`). Both are listed through ONE endpoint
// (POST /classifier/search, confirmed via demisto-sdk's
// `Downloader.ITEM_TYPE_TO_ENDPOINT[CLASSIFIER|MAPPER]`, which map to the same
// path) and written through ONE import endpoint
// (POST /classifier/import — confirmed via demisto-py's generated
// `import_classifier` and demisto-sdk's `Classifier`/`Mapper._client_upload_method`,
// both of which resolve to `client.import_classifier`).
//
// `/classifier/import` is a multipart request: the classifier/mapper JSON as a
// `file` part PLUS a required `classifierId` form field carrying the object's
// own `id` — sent on BOTH create and update (confirmed: `classifier_id` is a
// required, not optional, parameter of the generated client method).
//
// DELETE is NOT independently confirmed by any of the sources above. It
// follows the same `POST /<resource>/delete` action-family already shipped and
// working in this app for lists and incident types — see README "Scope &
// honesty" for the full caveat. Unlike fields (a bulk collection with no
// per-item GET), `/classifier/import` addresses one object by its own `id`, so
// the delete body here is a single id, not an array.
// =============================================================================

import { parseJson, xsoarErrorMessage, type XsoarClient } from '../../lib/xsoar'

export type ClassificationKind = 'classifier' | 'mapper'
export type MapperDirection = 'incoming' | 'outgoing'

export const CLASSIFIER_TYPE = 'classification'
export const MAPPER_TYPE_BY_DIRECTION: Record<MapperDirection, string> = {
  incoming: 'mapping-incoming',
  outgoing: 'mapping-outgoing',
}
const MAPPER_TYPES = new Set(Object.values(MAPPER_TYPE_BY_DIRECTION))

/** Shape of a classifier/mapper returned by POST /classifier/search. Only the fields this app reads/writes. */
export interface LiveClassification {
  id?: string
  name?: string
  description?: string
  type?: string
  feed?: boolean
  defaultIncidentType?: string
  definitionId?: string
  /** Classifier routing logic — deep/variable shape, carried as-is. */
  keyTypeMap?: Record<string, unknown>
  transformer?: Record<string, unknown>
  /** Mapper field-mapping graph — deep/variable shape, carried as-is. */
  mapping?: Record<string, unknown>
  version?: number
  system?: boolean
  locked?: boolean
}

/** True for a built-in / locked classifier or mapper. The pipeline refuses to modify or delete these. */
export function isProtectedClassification(item: LiveClassification): boolean {
  return item.system === true || item.locked === true
}

/**
 * Parse a canvas JSON-blob field (a classifier's `keyTypeMap`/`transformer`, a
 * mapper's `mapping`) into a plain object. Blank input parses as an empty
 * object (an empty classifier/mapper); malformed JSON or a non-object value
 * reports an error instead of silently dropping content.
 */
export function parseConfigBlob(raw: string): { value: Record<string, unknown>; error: string | null } {
  const trimmed = raw.trim()
  if (!trimmed) return { value: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { value: {}, error: 'must be valid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: {}, error: 'must be a JSON object' }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

/** True when `type` marks a plain classifier (as opposed to a mapper). */
export function isClassifierType(type: string | undefined): boolean {
  return type === CLASSIFIER_TYPE
}

/** True when `type` marks a mapper (either direction). */
export function isMapperType(type: string | undefined): boolean {
  return type !== undefined && MAPPER_TYPES.has(type)
}

/** The mapper direction encoded in a `mapping-incoming` / `mapping-outgoing` type value, if any. */
export function mapperDirectionOf(type: string | undefined): MapperDirection | null {
  if (type === MAPPER_TYPE_BY_DIRECTION.incoming) return 'incoming'
  if (type === MAPPER_TYPE_BY_DIRECTION.outgoing) return 'outgoing'
  return null
}

/**
 * List every classifier/mapper via POST /classifier/search. The exact response
 * envelope is not independently confirmed (only the path + method are), so this
 * accepts the shapes XSOAR search endpoints are known to use elsewhere in this
 * app — a bare array, `{ classifiers: [...] }`, or the `{ data: [...] }`
 * envelope `/jobs/search` uses — falling back to empty rather than guessing.
 */
export async function searchClassifications(client: XsoarClient): Promise<LiveClassification[]> {
  const res = await client.request('POST', '/classifier/search', { body: { page: 0, size: 500 } })
  if (!res.ok) throw new Error(`Failed to search classifiers: ${xsoarErrorMessage(res)}`)
  const parsed = parseJson<unknown>(res.body)
  if (Array.isArray(parsed)) return parsed as LiveClassification[]
  if (parsed && typeof parsed === 'object') {
    const env = parsed as { classifiers?: unknown; data?: unknown }
    if (Array.isArray(env.classifiers)) return env.classifiers as LiveClassification[]
    if (Array.isArray(env.data)) return env.data as LiveClassification[]
  }
  return []
}

/** XSOAR content-version convention: -1 marks a brand-new item and overrides an existing one on update. */
export const CLASSIFICATION_VERSION = -1

/**
 * Upsert one classifier/mapper via POST /classifier/import (multipart; the
 * `classifierId` form field is required on both create and update). Throws on
 * a non-OK response.
 */
export async function saveClassification(client: XsoarClient, id: string, body: Record<string, unknown>): Promise<void> {
  const res = await client.requestMultipart('/classifier/import', {
    file: { filename: `${id}.json`, content: JSON.stringify(body) },
    fields: { classifierId: id },
  })
  if (!res.ok) throw new Error(`Failed to save "${id}": ${xsoarErrorMessage(res)}`)
}

/**
 * Delete one classifier/mapper by id via POST /classifier/delete, `{ id }`.
 *
 * BEST-EFFORT / INFERRED CONVENTION — see module docstring. A 404 is treated as
 * already-deleted (success); any other failure is surfaced verbatim.
 */
export async function deleteClassification(client: XsoarClient, id: string): Promise<void> {
  const res = await client.request('POST', '/classifier/delete', { body: { id } })
  if (res.status !== 404 && !res.ok) {
    throw new Error(`Failed to delete "${id}": ${xsoarErrorMessage(res)}`)
  }
}
