import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { createCustomGroup, getCustomGroupsList } from '../../lib/gravityZoneApi'
import { extractNetworkGroupSpecs, findLiveGroup } from './_shared'

export interface NetworkGroupRollbackEntry {
  groupName: string
  parentId: string
  action: 'created' | 'unchanged'
  newId?: string
  force: boolean
}

/**
 * Deploy GravityZone network groups, reconciled by (groupName, parentId):
 *   create: network.createCustomGroup    when no direct child of parentId has this name
 *   no-op:  nothing                       when a matching child already exists
 *
 * There is no update — a group has no other declared field to change once it
 * exists, and GravityZone has no rename API (see README.md "Coverage").
 * Groups are grouped by declared parentId so each parent's live children are
 * listed only once even when several groups share a parent.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractNetworkGroupSpecs(ctx.canvas).filter((s) => s.groupName)
  const previous: NetworkGroupRollbackEntry[] = []
  const deployed: string[] = []
  const liveByParent = new Map<string, Awaited<ReturnType<typeof getCustomGroupsList>>>()

  try {
    for (const spec of specs) {
      const parentKey = spec.parentId || '(root)'
      let live = liveByParent.get(parentKey)
      if (!live) {
        live = await getCustomGroupsList(client, spec.parentId || undefined)
        liveByParent.set(parentKey, live)
      }

      const match = findLiveGroup(live, spec.groupName)
      if (!match) {
        const created = await createCustomGroup(client, spec.groupName, spec.parentId || undefined)
        previous.push({ groupName: spec.groupName, parentId: spec.parentId, action: 'created', newId: created.id, force: spec.force })
        // Keep this parent's cached list consistent for subsequent specs in the same batch.
        live.push({ id: created.id, name: spec.groupName, parentId: spec.parentId || undefined })
      } else {
        previous.push({ groupName: spec.groupName, parentId: spec.parentId, action: 'unchanged', force: spec.force })
      }
      deployed.push(spec.groupName)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} network group(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network group deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
