// Shared helpers for the Endpoints config type (validate + deploy + rollback +
// drift). Field shapes verified against the community pyise-ers ERS client
// (add_endpoint / get_endpoint / update_endpoint_group —
// github.com/falkowich/pyise-ers, pyiseers/pyiseers.py) AND a Cisco-published
// curl example (networkjourney.com ISE Mastery Training) — both independently
// showed the irregular "ERSEndPoint" wrapper key.
//
// Dropped / out of scope (see the app README): profiler policy assignment
// (`profileId`/`staticProfileAssignment`), portal-user linkage (`portalUser`)
// and custom attributes — all real ERSEndPoint fields, none implemented here.

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { IseEndpoint } from '../../lib/iseApi'

export const MAX_DESCRIPTION_LENGTH = 1000
const MAC_RE = /^([0-9A-Fa-f]{2})[:-]?([0-9A-Fa-f]{2})[:-]?([0-9A-Fa-f]{2})[:-]?([0-9A-Fa-f]{2})[:-]?([0-9A-Fa-f]{2})[:-]?([0-9A-Fa-f]{2})$/

/** Validate a MAC in any common separator style (colon, dash, or none). */
export function isValidMac(value: string): boolean {
  return MAC_RE.test(value.trim())
}

/** Normalize a MAC to ISE's canonical uppercase colon-separated form. Returns the input unchanged if invalid (validate.ts rejects it). */
export function normalizeMac(value: string): string {
  const m = MAC_RE.exec(value.trim())
  if (!m) return value.trim()
  return m.slice(1, 7).join(':').toUpperCase()
}

export interface EndpointSpec {
  mac: string
  description: string
  /** An endpoint identity group NAME — resolved to an id at deploy/drift time. */
  groupName: string
}

export function specFromItem(item: CanvasItemSnapshot): EndpointSpec {
  const rawMac = String(item.fields.mac ?? '').trim()
  return {
    mac: isValidMac(rawMac) ? normalizeMac(rawMac) : rawMac,
    description: String(item.fields.description ?? '').trim(),
    groupName: String(item.fields.group_name ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): EndpointSpec[] {
  return items.map(specFromItem)
}

/**
 * The ERS create/update body. `groupId` is the ALREADY-RESOLVED id for
 * `spec.groupName` (see deploy.ts) — when absent, `groupId`/
 * `staticGroupAssignment` are both omitted so ISE's profiler remains free to
 * assign a group. ISE's own default: the endpoint's `name` is its MAC.
 */
export function toIseEndpointBody(spec: EndpointSpec, groupId: string | null): Omit<IseEndpoint, 'id' | 'link'> {
  const body: Omit<IseEndpoint, 'id' | 'link'> = { name: spec.mac, description: spec.description, mac: spec.mac }
  if (groupId) {
    body.groupId = groupId
    body.staticGroupAssignment = 'true'
  }
  return body
}
