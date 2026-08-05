import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient, type SophosClient } from '../../lib/sophosCentral'
import { sameSet } from '../../lib/sophosCommon'
import {
  addEndpointsToGroup,
  createEndpointGroup,
  listEndpointGroups,
  listGroupEndpointIds,
  removeEndpointsFromGroup,
  updateEndpointGroup,
  type SophosEndpointGroup,
} from '../../lib/sophosApi'
import { buildEndpointGroupCreateBody, endpointGroupDetailsMatch, endpointGroupKey, extractEndpointGroupSpecs } from './_shared'

export interface EndpointGroupRollbackEntry {
  name: string
  existed: boolean
  id?: string
  /** Prior name/description, only when the group already existed. */
  priorDetails?: { name: string; description?: string }
  /** The FULL prior membership snapshot — restored by diffing against current membership on rollback. */
  priorMembers?: string[]
}

/**
 * Reconcile a group's membership to `desiredIds`, returning the FULL prior
 * membership snapshot (before any change) so rollback can restore it exactly
 * by diffing against whatever the membership looks like at rollback time.
 */
async function reconcileMembership(client: SophosClient, groupId: string, desiredIds: string[]): Promise<string[]> {
  const current = await listGroupEndpointIds(client, groupId)
  if (!sameSet(desiredIds, current)) {
    const currentSet = new Set(current)
    const desiredSet = new Set(desiredIds)
    const toAdd = desiredIds.filter((id) => !currentSet.has(id))
    const toRemove = current.filter((id) => !desiredSet.has(id))
    if (toAdd.length > 0) await addEndpointsToGroup(client, groupId, toAdd)
    if (toRemove.length > 0) await removeEndpointsFromGroup(client, groupId, toRemove)
  }
  return current
}

/**
 * Deploy Sophos Central endpoint groups, reconciled by NAME:
 *   list:   GET    /endpoint-groups                                  -> find by name
 *   update: PATCH  /endpoint-groups/{id}                              name/description, when found and different
 *   create: POST   /endpoint-groups                                   when not found (endpointIds seeded at create)
 *   members: reconcile the group's endpoint-id set via the .../endpoints
 *            add/remove sub-resource so an existing group's membership
 *            converges to exactly what's declared.
 *
 * `type` is immutable — a live group whose type differs from the declared
 * spec keeps its live type; deploy never attempts to change it (Sophos's
 * PATCH does not accept it).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractEndpointGroupSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const previous: EndpointGroupRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const live = await listEndpointGroups(client)
    const liveByName = new Map<string, SophosEndpointGroup>(live.filter((g) => g.name).map((g) => [endpointGroupKey(g.name), g]))

    for (const spec of specs) {
      const match = liveByName.get(endpointGroupKey(spec.name))

      if (!match) {
        const created = await createEndpointGroup(client, buildEndpointGroupCreateBody(spec))
        previous.push({ name: spec.name, existed: false, id: created.id })
      } else {
        const priorDetails = { name: match.name, description: match.description }
        if (match.id && !endpointGroupDetailsMatch(spec, match)) {
          await updateEndpointGroup(client, match.id, { name: spec.name, description: spec.description || undefined })
        }
        const priorMembers = match.id ? await reconcileMembership(client, match.id, spec.endpointIds) : []
        previous.push({ name: spec.name, existed: true, id: match.id, priorDetails, priorMembers })
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} endpoint group(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Endpoint group deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}

export { reconcileMembership }
