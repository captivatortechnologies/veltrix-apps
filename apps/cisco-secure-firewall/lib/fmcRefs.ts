// =============================================================================
// Cross-object name resolution for FMC config types that reference OTHER FMC
// objects by name (Access Rules' zones/networks/ports; Network/Port/URL
// Groups' members). FMC's REST API always wants a `{"id": "...", "type":
// "..."}` reference, never a bare name, so every reference field on the
// canvas is a human-typed NAME that these helpers resolve to the referenced
// object's real `id` + `type` at deploy/drift time (the object must already
// exist - the same "objects are created before the rules that reference
// them" ordering apps/palo-alto-panorama's security-rules relies on).
//
// Each index is built ONCE per pipeline invocation (a handful of `list()`
// calls) and reused for every item/member in that canvas, rather than
// re-querying per reference.
// =============================================================================

import type { FmcClient, FmcObject } from './fmc'
import { HOSTS_PATH, NETWORKS_PATH, RANGES_PATH, FQDNS_PATH } from '../config-types/network-objects/validate'
import { NETWORK_GROUPS_PATH } from '../config-types/network-groups/validate'
import { PORT_OBJECTS_PATH } from '../config-types/port-objects/validate'
import { SECURITY_ZONES_PATH } from '../config-types/security-zones/validate'
import { URL_OBJECTS_PATH } from '../config-types/url-objects/validate'
import { ACCESS_POLICIES_PATH } from '../config-types/access-control-policies/validate'

export interface ObjectRef {
  id: string
  type: string
  name: string
}

export type RefIndex = Map<string, ObjectRef>

function indexOf(items: FmcObject[]): RefIndex {
  const map: RefIndex = new Map()
  for (const item of items) {
    if (typeof item.id === 'string' && typeof item.name === 'string' && typeof item.type === 'string') {
      map.set(item.name.toLowerCase(), { id: item.id, type: item.type, name: item.name })
    }
  }
  return map
}

async function listIndex(client: FmcClient, path: string): Promise<RefIndex> {
  const listed = await client.list(path)
  return listed.ok ? indexOf(listed.items) : new Map()
}

/**
 * Network-object index: Hosts, Networks, Ranges, FQDNs and Network Groups
 * merged into one name -> {id, type} map, the same set of types a security
 * rule's source/destination network condition or a Network Group's members
 * may reference. A name collision across types keeps whichever was indexed
 * last (Network Groups win); this is flagged as a limitation in README.md
 * rather than silently guessed at.
 */
export async function buildNetworkObjectIndex(client: FmcClient): Promise<RefIndex> {
  const merged: RefIndex = new Map()
  for (const path of [HOSTS_PATH, NETWORKS_PATH, RANGES_PATH, FQDNS_PATH, NETWORK_GROUPS_PATH]) {
    const idx = await listIndex(client, path)
    for (const [name, ref] of idx) merged.set(name, ref)
  }
  return merged
}

/**
 * Port-object index: plain protocol/port objects only (`/object/protocolportobjects`).
 * FMC's Port Group members may also be ICMPv4/ICMPv6 objects, which this app
 * does not manage (see README Coverage) - referencing a name that is only an
 * ICMP object here resolves to nothing and surfaces as a clear deploy error.
 */
export async function buildPortObjectIndex(client: FmcClient): Promise<RefIndex> {
  return listIndex(client, PORT_OBJECTS_PATH)
}

/** Security Zone index (`/object/securityzones`) - what Access Rules' source/destination zones reference. */
export async function buildZoneIndex(client: FmcClient): Promise<RefIndex> {
  return listIndex(client, SECURITY_ZONES_PATH)
}

/** URL-object index (`/object/urls`) - what URL Groups' object members (as opposed to literal URLs) reference. */
export async function buildUrlObjectIndex(client: FmcClient): Promise<RefIndex> {
  return listIndex(client, URL_OBJECTS_PATH)
}

/** Access Control Policy index (`/policy/accesspolicies`) - what Access Rules' `policy_name` resolves against. */
export async function buildAccessControlPolicyIndex(client: FmcClient): Promise<RefIndex> {
  return listIndex(client, ACCESS_POLICIES_PATH)
}

/** Resolve a list of names against an index; returns the resolved refs and any names that had no match. */
export function resolveRefs(index: RefIndex, names: string[]): { resolved: ObjectRef[]; missing: string[] } {
  const resolved: ObjectRef[] = []
  const missing: string[] = []
  for (const name of names) {
    const ref = index.get(name.trim().toLowerCase())
    if (ref) resolved.push(ref)
    else missing.push(name)
  }
  return { resolved, missing }
}
