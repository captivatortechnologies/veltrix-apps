import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractNetworkAppGroupSpecs,
  type LiveNetworkAppGroup,
  type NetworkAppGroupSpec,
} from './validate'

export interface NetworkAppGroupRollbackEntry {
  name: string
  existed: boolean
  id?: number
  prior?: { name?: string; description?: string; networkApplications?: string[] }
}

/**
 * Deploy ZIA network application groups via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /networkApplicationGroups,
 * match by name, then PUT an existing group or POST a new one. ZIA STAGES every
 * write — nothing takes effect until activation — so this writes all groups,
 * then calls activate() ONCE at the end. If activation fails the writes remain
 * staged and rollbackData is returned so the platform can revert them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractNetworkAppGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: NetworkAppGroupRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listNetworkAppGroups(client)
    const byName = new Map(existing.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: live.name,
            description: live.description ?? '',
            networkApplications: Array.isArray(live.networkApplications) ? live.networkApplications : [],
          },
        })
        const res = await client.zia('PUT', `/networkApplicationGroups/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update network application group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/networkApplicationGroups', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create network application group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveNetworkAppGroup>(res.body)
        if (created?.id == null) {
          throw new Error(`Network application group "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA network application group(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedGroups: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA network application group(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network application group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA network application groups; throws on a non-OK response. */
export async function listNetworkAppGroups(client: ZscalerClient): Promise<LiveNetworkAppGroup[]> {
  const res = await client.ziaGetAll<LiveNetworkAppGroup>('/networkApplicationGroups')
  if (!res.ok) {
    throw new Error(
      `Failed to list network application groups: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a network application group by name; null when absent. */
export async function findNetworkAppGroup(
  client: ZscalerClient,
  name: string,
): Promise<LiveNetworkAppGroup | null> {
  const all = await listNetworkAppGroups(client)
  return all.find((g) => g.name === name) ?? null
}

function buildPayload(spec: NetworkAppGroupSpec): Record<string, unknown> {
  // description always sent (even empty) so clearing it converges the live group.
  return {
    name: spec.name,
    description: spec.description ?? '',
    networkApplications: spec.networkApplications,
  }
}
