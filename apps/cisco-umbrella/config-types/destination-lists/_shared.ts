// Shared helpers for the Cisco Umbrella Destination Lists config type
// (validate + deploy + rollback + drift).
//
// Umbrella destination lists are addressed by an opaque numeric id (no
// lookup-by-name), so the app matches a declared list to a live one by NAME and
// stores the id from the deploy for rename-safety. A list's `access`
// (allow/block) and `isGlobal` scope are fixed at create time and cannot be
// changed afterward. Shapes follow the Umbrella API (/policies/v2/destinationlists);
// verify against a live Umbrella tenant.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { MAX_DESTINATIONS_PER_REQUEST, parseJson, umbrellaErrorMessage } from '../../lib/umbrellaApi'
import type { UmbrellaClient, UmbrellaEnvelope } from '../../lib/umbrellaApi'

/** Valid destination-list access modes. */
export const ACCESS_VALUES = new Set(['allow', 'block'])
/** Umbrella caps a single destination list at 500 destinations per create. */
export const MAX_DESTINATIONS = 500
export const MAX_NAME_LENGTH = 50

export const LIST_PATH = '/policies/v2/destinationlists'
export function listPath(id: string | number): string {
  return `${LIST_PATH}/${encodeURIComponent(String(id))}`
}
export function destinationsPath(id: string | number): string {
  return `${listPath(id)}/destinations`
}
export function removeDestinationsPath(id: string | number): string {
  return `${destinationsPath(id)}/remove`
}

export type DestinationType = 'domain' | 'url' | 'ipv4'

/** One destination list declared on the canvas (one item). */
export interface DestinationListSpec {
  itemId?: string
  /** name — the logical identity (Umbrella lists are id-addressed). */
  name: string
  access: string
  isGlobal: boolean
  /** Deduped, trimmed destination values (domains / URLs / IPs). */
  destinations: string[]
}

/** A destination list as returned by GET /policies/v2/destinationlists. */
export interface LiveDestinationList {
  id: number | string
  name?: string
  access?: string
  isGlobal?: boolean
  meta?: { destinationCount?: number }
}

/** A destination inside a list as returned by GET .../destinations. */
export interface LiveDestination {
  id: number | string
  destination?: string
  type?: string
  comment?: string
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/\d{1,2})?$/

/**
 * Classify a destination the way Umbrella does: an IPv4 (or CIDR), a URL (has a
 * scheme or a path), or a bare domain. Used for validation warnings — Umbrella
 * itself derives the type on add (only `destination` + optional `comment` are
 * sent).
 */
export function classifyDestination(value: string): DestinationType {
  const v = value.trim()
  if (IPV4_RE.test(v)) return 'ipv4'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.includes('/')) return 'url'
  return 'domain'
}

/** Case-insensitive key for comparing destination values across canvas + live. */
export function destinationKey(value: string): string {
  return value.trim().toLowerCase()
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1 || v === '1') return true
  return false
}

/**
 * Split a textarea (one destination per line; commas also tolerated) into a
 * deduped, trimmed list preserving first-seen order.
 */
export function splitDestinations(value: unknown): string[] {
  const raw = typeof value === 'string' ? value : Array.isArray(value) ? value.join('\n') : ''
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[\r\n,]+/)) {
    const item = part.trim()
    if (!item) continue
    const key = destinationKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export function extractDestinationListSpecs(canvas: CanvasSnapshot): DestinationListSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    access: asString(item.fields?.access).toLowerCase() || 'block',
    isGlobal: asBoolean(item.fields?.isGlobal),
    destinations: splitDestinations(item.fields?.destinations),
  }))
}

/** Read every destination in a list (paged), or the failing response. */
export async function listDestinations(
  client: UmbrellaClient,
  listId: string | number,
): Promise<{ ok: boolean; items: LiveDestination[]; lastError?: string }> {
  const res = await client.getAll<LiveDestination>(destinationsPath(listId))
  if (!res.ok) return { ok: false, items: [], lastError: res.lastError ? umbrellaErrorMessage(res.lastError) : 'list failed' }
  return { ok: true, items: res.items }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export interface SyncResult {
  added: number
  removed: number
  errors: string[]
}

/**
 * Converge a list's destinations to exactly `desired`: add the declared values
 * that are missing and remove the live ones no longer declared. Batches of 500
 * (Umbrella's per-request cap). Shared by deploy (sync to declared) and rollback
 * (sync back to the prior set). Returns counts + any per-batch errors.
 */
export async function syncDestinations(
  client: UmbrellaClient,
  listId: string | number,
  desired: string[],
): Promise<SyncResult> {
  const result: SyncResult = { added: 0, removed: 0, errors: [] }

  const live = await listDestinations(client, listId)
  if (!live.ok) {
    result.errors.push(`read destinations: ${live.lastError}`)
    return result
  }

  const desiredKeys = new Map<string, string>()
  for (const d of desired) desiredKeys.set(destinationKey(d), d)

  const liveKeys = new Map<string, LiveDestination>()
  for (const d of live.items) {
    if (d.destination) liveKeys.set(destinationKey(d.destination), d)
  }

  const toAdd: string[] = []
  for (const [key, value] of desiredKeys) if (!liveKeys.has(key)) toAdd.push(value)

  const toRemove: Array<number | string> = []
  for (const [key, d] of liveKeys) if (!desiredKeys.has(key)) toRemove.push(d.id)

  for (const batch of chunk(toAdd, MAX_DESTINATIONS_PER_REQUEST)) {
    const res = await client.post(destinationsPath(listId), batch.map((destination) => ({ destination })))
    if (!res.ok) result.errors.push(`add destinations: ${umbrellaErrorMessage(res)}`)
    else result.added += batch.length
  }

  for (const batch of chunk(toRemove, MAX_DESTINATIONS_PER_REQUEST)) {
    const res = await client.delete(removeDestinationsPath(listId), batch)
    if (!res.ok) result.errors.push(`remove destinations: ${umbrellaErrorMessage(res)}`)
    else result.removed += batch.length
  }

  return result
}

/** Unwrap a single-object `{ status, data }` envelope. */
export function dataOf<T>(body: string): T | null {
  const env = parseJson<UmbrellaEnvelope<T>>(body)
  return (env?.data as T) ?? null
}
