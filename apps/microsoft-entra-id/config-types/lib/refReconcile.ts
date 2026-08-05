// =============================================================================
// Generic provenance-tracked $ref collection reconcile — the same mechanics
// administrative-units/deploy.ts's `reconcileMembers` established for
// administrativeUnit.members, generalized here for reuse across this batch's
// TWO owners relationships (application.owners, servicePrincipal.owners),
// which are structurally identical: a flat directoryObject collection at
// `{base}/owners`, added/removed one at a time via `.../owners/$ref` with a
// `directoryObjects/{id}` @odata.id.
//
// VERIFIED shapes:
//   POST /applications/{id}/owners/$ref | POST /servicePrincipals/{id}/owners/$ref
//     body {"@odata.id":"https://graph.microsoft.com/v1.0/directoryObjects/{id}"}
//     (https://learn.microsoft.com/graph/api/application-post-owners,
//      https://learn.microsoft.com/graph/api/serviceprincipal-post-owners)
//   DELETE /applications/{id}/owners/{id}/$ref | DELETE /servicePrincipals/{id}/owners/{id}/$ref
//     — the trailing "/$ref" is NOT optional: without it (and if the caller's
//     credential can manage the owner object), Graph deletes the owner
//     directory object itself instead of just the ownership reference
//     (https://learn.microsoft.com/graph/api/application-delete-owners).
//
// Kept as a THIRD independent copy of this mechanic (after
// conditional-access-policies' inline id-resolution and administrative-units'
// reconcileMembers) rather than folding administrative-units over to reuse
// it — see lib/nameMaps.ts's header for why this app deliberately keeps small
// per-batch mechanics separate instead of coupling unrelated config types'
// deploy pipelines together. This file exists because it IS shared within
// THIS batch (applications + service-principals owners), not across batches.
// =============================================================================

import { graphErrorMessage, type GraphClient } from '../../lib/graph'

/** One tracked directoryObject reference (e.g. an owner), with provenance. */
export interface RefMemberEntry {
  id: string
  /** false = this app added the reference; true = it already existed before this app touched it. */
  existed: boolean
}

/** GET the current member object ids of a `{base}/{refName}` collection (paginated). */
export async function listRefIds(
  client: GraphClient,
  base: string,
  refName: string
): Promise<{ ok: boolean; ids: Set<string> }> {
  const listed = await client.getAll<{ id?: string }>(`${base}/${refName}?$select=id`)
  const ids = new Set<string>()
  if (listed.ok) {
    for (const m of listed.items) if (m.id) ids.add(m.id)
  }
  return { ok: listed.ok, ids }
}

/**
 * Reconcile a `{base}/{refName}` directoryObject $ref collection to the
 * declared set of ids. Adds a missing reference via POST
 * `{base}/{refName}/$ref` with a `directoryObjects/{id}` @odata.id; removes
 * ONLY references THIS app itself previously added (existed:false) that are
 * no longer declared, via DELETE `{base}/{refName}/{id}/$ref` — a reference
 * that already existed before this app touched it is left alone even if it
 * later drops off the canvas.
 */
export async function reconcileRefCollection(
  client: GraphClient,
  base: string,
  refName: string,
  desiredIds: string[],
  priorMembers: RefMemberEntry[]
): Promise<{ members: RefMemberEntry[]; failures: string[] }> {
  const live = await listRefIds(client, base, refName)
  if (!live.ok) {
    return { members: priorMembers, failures: [`could not list current ${refName} — left unchanged`] }
  }

  const priorById = new Map(priorMembers.map((m) => [m.id, m]))
  const desiredSet = new Set(desiredIds)
  const members: RefMemberEntry[] = []
  const failures: string[] = []

  for (const id of desiredIds) {
    if (live.ids.has(id)) {
      members.push({ id, existed: priorById.get(id)?.existed ?? true })
      continue
    }
    const resp = await client.post(`${base}/${refName}/$ref`, {
      '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${id}`,
    })
    if (!resp.ok) {
      failures.push(`add ${refName.slice(0, -1)} ${id}: ${graphErrorMessage(resp)}`)
      continue
    }
    members.push({ id, existed: false })
  }

  for (const p of priorMembers) {
    if (p.existed || desiredSet.has(p.id) || !live.ids.has(p.id)) continue
    const resp = await client.delete(`${base}/${refName}/${p.id}/$ref`)
    if (!resp.ok && resp.status !== 404) {
      failures.push(`remove ${refName.slice(0, -1)} ${p.id}: ${graphErrorMessage(resp)}`)
    }
  }

  return { members, failures }
}
