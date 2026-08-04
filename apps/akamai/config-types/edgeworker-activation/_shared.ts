// Shared helpers for the Akamai EdgeWorker Activation config type. Activation
// is a SEPARATE step from managing EdgeWorker identity (the edgeworkers type):
// it promotes an EXISTING code bundle VERSION (built/uploaded out of band —
// see edgeworkers/_shared.ts) onto STAGING or PRODUCTION.
//
// Endpoints (EdgeWorkers API v1, EdgeGrid-signed):
//   list activations:   GET  /edgeworkers/v1/ids/{id}/activations
//   activate:            POST /edgeworkers/v1/ids/{id}/activations    { network, version, note }
//   list deactivations:  GET  /edgeworkers/v1/ids/{id}/deactivations
//   deactivate:          POST /edgeworkers/v1/ids/{id}/deactivations  { network, version, note }
//
// Unlike Network List Activation, EdgeWorkers exposes a REAL deactivation
// operation (a distinct resource, not a flag on the same call) — so rollback
// here can genuinely undo an activation, the same improvement documented for
// Cloudlets Policy Activation. The activations list has no per-network
// filter, so the current state per network is derived client-side: the
// most-recently-created activation for that network, unless a later
// deactivation supersedes it.

import { edgeWorkerPath, edgeWorkersFromResponse, findEdgeWorker, edgeWorkersPath, type EdgeWorker } from '../edgeworkers/_shared'

export { edgeWorkersFromResponse, findEdgeWorker, edgeWorkersPath, type EdgeWorker }

/** The two EdgeWorkers activation networks. */
export const NETWORKS = new Set(['STAGING', 'PRODUCTION'])

/** Requests still in flight — safe to leave alone rather than re-trigger. */
const IN_FLIGHT_STATUSES = new Set(['PRESUBMIT', 'PENDING', 'IN_PROGRESS', 'CANCELLING'])

/** Terminal statuses that mean the request did NOT take effect. */
const FAILED_STATUSES = new Set(['CANCELLED', 'CANCELED', 'ABORTED', 'FAILED'])

export function normalizeNetwork(value: unknown): string {
  const n = String(value ?? '').trim().toUpperCase()
  return NETWORKS.has(n) ? n : 'STAGING'
}

export function activationsPath(edgeWorkerId: number): string {
  return `${edgeWorkerPath(edgeWorkerId)}/activations`
}

export function deactivationsPath(edgeWorkerId: number): string {
  return `${edgeWorkerPath(edgeWorkerId)}/deactivations`
}

export interface EdgeWorkerActivation {
  activationId?: number
  edgeWorkerId?: number
  version?: string
  network?: string
  status?: string
  note?: string
  createdTime?: string
  [key: string]: unknown
}

/** Unwrap the `{ activations: [...] }` collection envelope into a flat array. */
export function activationsFromResponse(payload: unknown): EdgeWorkerActivation[] {
  if (payload && typeof payload === 'object' && Array.isArray((payload as { activations?: unknown }).activations)) {
    return (payload as { activations: EdgeWorkerActivation[] }).activations
  }
  return Array.isArray(payload) ? (payload as EdgeWorkerActivation[]) : []
}

/** Is a request still in flight (safe to leave alone rather than re-trigger)? */
export function isInFlight(status: string | undefined): boolean {
  return IN_FLIGHT_STATUSES.has(String(status ?? '').toUpperCase())
}

/** Did a terminal request fail to take effect? */
export function isFailed(status: string | undefined): boolean {
  return FAILED_STATUSES.has(String(status ?? '').toUpperCase())
}

/**
 * The most recently created activation for a network (any status) — the
 * candidate for "what's currently effective / in flight there". Activations
 * have no guaranteed sort order from the API, so this sorts by createdTime.
 */
export function latestForNetwork(activations: EdgeWorkerActivation[], network: string): EdgeWorkerActivation | null {
  const forNetwork = activations.filter((a) => String(a.network ?? '').toUpperCase() === network.toUpperCase())
  if (forNetwork.length === 0) return null
  return forNetwork.reduce((best, a) => ((a.createdTime ?? '') > (best.createdTime ?? '') ? a : best))
}

/** The version currently effective (successfully activated, not superseded/failed) for a network, or null. */
export function effectiveVersion(activations: EdgeWorkerActivation[], network: string): string | null {
  const latest = latestForNetwork(activations, network)
  if (!latest || isInFlight(latest.status) || isFailed(latest.status)) return null
  return latest.version ?? null
}

export interface ActivationFields {
  edgeWorkerName: string
  network: string
  version: string
  note: string
}

/** Read + normalize the canvas fields for one activation item. */
export function readActivationFields(fields: Record<string, unknown>): ActivationFields {
  return {
    edgeWorkerName: String(fields.edgeWorkerName ?? '').trim(),
    network: normalizeNetwork(fields.network),
    version: String(fields.version ?? '').trim(),
    note: String(fields.note ?? '').trim(),
  }
}
