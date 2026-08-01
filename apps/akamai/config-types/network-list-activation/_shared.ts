// Shared helpers for the Akamai Network List activation config type. Activation
// is a SEPARATE step from managing list content (the network-lists type): it
// promotes a list's most recent syncPoint version onto STAGING or PRODUCTION.
//
// Endpoints (Network Lists API v2, EdgeGrid-signed — verified against
// techdocs.akamai.com):
//   activate: POST /network-list/v2/network-lists/{id}/environments/{env}/activate
//   status:   GET  /network-list/v2/network-lists/{id}/environments/{env}/status
// (docs: post-network-list-activate, get-network-list-status, activation-states)
//
// The list is resolved by NAME (its stable identity, shared with the
// network-lists type) via the collection endpoint, so this config never stores
// an opaque uniqueId.

import { NETWORK_LISTS_PATH, parseJson, type AkamaiClient } from '../../lib/akamaiApi'

// Reuse the Network Lists collection helpers — activation targets the same API.
export { findList, listsFromResponse, type NetworkList } from '../network-lists/_shared'

/** The two Akamai activation environments. */
export const NETWORKS = new Set(['STAGING', 'PRODUCTION'])

/**
 * Activation status values returned by the status endpoint
 * (techdocs "activation-states"):
 *   INACTIVE / PENDING_ACTIVATION / ACTIVE / MODIFIED / PENDING_DEACTIVATION / FAILED
 * ACTIVE = the current syncPoint is live; MODIFIED = an OLDER syncPoint is live
 * and edits await activation; PENDING_* = an activation/deactivation is in flight.
 */
export const ACTIVE_STATE = 'ACTIVE'
export const PENDING_STATES = new Set(['PENDING_ACTIVATION', 'PENDING_DEACTIVATION'])

/** Activation-status response shape (fields we rely on). */
export interface ActivationStatus {
  activationId?: number
  activationStatus?: string
  /** The syncPoint version currently activated in this environment. */
  syncPoint?: number
  uniqueId?: string
  [key: string]: unknown
}

/** Build the activate endpoint path for a list + environment. */
export function activatePath(uniqueId: string, network: string): string {
  return `${NETWORK_LISTS_PATH}/${encodeURIComponent(uniqueId)}/environments/${network}/activate`
}

/** Build the activation-status endpoint path for a list + environment. */
export function statusPath(uniqueId: string, network: string): string {
  return `${NETWORK_LISTS_PATH}/${encodeURIComponent(uniqueId)}/environments/${network}/status`
}

/** Normalize a network value from the canvas to STAGING or PRODUCTION (defaults to STAGING). */
export function normalizeNetwork(value: unknown): string {
  const n = String(value ?? '').trim().toUpperCase()
  return NETWORKS.has(n) ? n : 'STAGING'
}

/**
 * Parse notification recipients (a `tags` field, textarea, or comma list) into a
 * clean, de-duplicated, order-preserving list of trimmed email addresses.
 */
export function parseRecipients(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((v) => String(v)) : String(value ?? '').split(/[\r\n,;]+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const e = entry.trim()
    if (!e) continue
    const key = e.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(e)
    }
  }
  return out
}

export interface ActivationFields {
  networkListName: string
  network: string
  comments: string
  recipients: string[]
}

/** Read + normalize the canvas fields for one activation item. */
export function readActivationFields(fields: Record<string, unknown>): ActivationFields {
  return {
    networkListName: String(fields.networkListName ?? '').trim(),
    network: normalizeNetwork(fields.network),
    comments: String(fields.comments ?? '').trim(),
    recipients: parseRecipients(fields.notificationRecipients),
  }
}

/**
 * Idempotency test: is the list already live at (or beyond) `targetSyncPoint` in
 * this environment? True only when the status is ACTIVE and the activated
 * syncPoint is at least the list's current version — i.e. there is nothing new
 * to activate. A `null` status (never activated / unreadable) is never active.
 */
export function isActiveAt(status: ActivationStatus | null, targetSyncPoint: number): boolean {
  if (!status || status.activationStatus !== ACTIVE_STATE) return false
  return (status.syncPoint ?? -1) >= targetSyncPoint
}

/** Is an activation/deactivation currently in flight for this list + environment? */
export function isPending(status: ActivationStatus | null): boolean {
  return !!status && PENDING_STATES.has(String(status.activationStatus))
}

/**
 * Read the current activation status for a list + environment, or null when it
 * cannot be read (e.g. the list has never been activated there, or a transient
 * error). Shared by deploy (idempotency) and driftDetect (read-only check).
 */
export async function readStatusOrNull(
  client: AkamaiClient,
  uniqueId: string,
  network: string,
): Promise<ActivationStatus | null> {
  const res = await client.request('GET', statusPath(uniqueId, network))
  if (!res.ok) return null
  return parseJson<ActivationStatus>(res.body)
}
