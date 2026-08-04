// Shared helpers for the Akamai EdgeWorkers config type. Shapes follow the
// EdgeWorkers API v1 (GET/POST/PUT/DELETE /edgeworkers/v1/ids[/{edgeWorkerId}]).
//
// SCOPE: this manages the EdgeWorker's IDENTITY only — its name, group and
// resource tier. The actual JavaScript code bundle is a gzipped tarball
// (bundle.json + main.js) uploaded as binary content, which has no clean
// text/JSON representation for a canvas field, so version creation/upload is
// OUT OF SCOPE here — code ships via CI/CD or the Akamai CLI, same as how
// this app treats certificate private keys or IdP secrets. Promoting an
// EXISTING version onto STAGING/PRODUCTION is a separate config type
// (edgeworker-activation), the same content/promotion split already used for
// Network Lists.
//
// A EdgeWorker is a PER-OBJECT resource — Akamai assigns each one a
// server-side numeric `edgeWorkerId` on create — so this reconciles by NAME
// (list, match by name, then update/create), the same shape as Cisco Meraki's
// Group Policies.

import { EDGEWORKERS_IDS_PATH } from '../../lib/akamaiApi'

/** An EdgeWorker id as the API returns/accepts it (fields we rely on). */
export interface EdgeWorker {
  edgeWorkerId?: number
  name?: string
  groupId?: number
  resourceTierId?: number
  accountId?: string
  sourceEdgeWorkerId?: number
  createdBy?: string
  createdTime?: string
  lastModifiedBy?: string
  lastModifiedTime?: string
  [key: string]: unknown
}

/** Unwrap the `{ edgeWorkerIds: [...] }` collection envelope into a flat array. */
export function edgeWorkersFromResponse(payload: unknown): EdgeWorker[] {
  if (payload && typeof payload === 'object' && Array.isArray((payload as { edgeWorkerIds?: unknown }).edgeWorkerIds)) {
    return (payload as { edgeWorkerIds: EdgeWorker[] }).edgeWorkerIds
  }
  return Array.isArray(payload) ? (payload as EdgeWorker[]) : []
}

/** Find a live EdgeWorker by (case-insensitive) name — the stable identity for upsert. */
export function findEdgeWorker(edgeWorkers: EdgeWorker[], name: string): EdgeWorker | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return edgeWorkers.find((e) => String(e.name ?? '').trim().toLowerCase() === n) ?? null
}

export interface EdgeWorkerFields {
  name: string
  groupId: number
  resourceTierId: number
}

/** Read + normalize the canvas fields for one EdgeWorker item. */
export function readEdgeWorkerFields(fields: Record<string, unknown>): EdgeWorkerFields {
  const groupIdRaw = fields.groupId
  const tierRaw = fields.resourceTierId
  return {
    name: String(fields.name ?? '').trim(),
    groupId: typeof groupIdRaw === 'number' && Number.isFinite(groupIdRaw) ? groupIdRaw : Number(groupIdRaw) || 0,
    resourceTierId: typeof tierRaw === 'number' && Number.isFinite(tierRaw) ? tierRaw : Number(tierRaw) || 0,
  }
}

/** Build the EdgeWorker create/update request body. */
export function buildEdgeWorkerBody(f: EdgeWorkerFields): Record<string, unknown> {
  return { name: f.name, groupId: f.groupId, resourceTierId: f.resourceTierId }
}

export const edgeWorkersPath = EDGEWORKERS_IDS_PATH
export const edgeWorkerPath = (edgeWorkerId: number): string => `${EDGEWORKERS_IDS_PATH}/${edgeWorkerId}`
