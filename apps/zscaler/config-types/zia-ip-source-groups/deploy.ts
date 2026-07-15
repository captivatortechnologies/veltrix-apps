import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractIpSourceGroupSpecs, type IpSourceGroupSpec, type LiveIpSourceGroup } from './validate'

export interface IpSourceGroupRollbackEntry {
  name: string
  existed: boolean
  id?: number
  prior?: { name?: string; description?: string; ipAddresses?: string[] }
}

/**
 * Deploy ZIA IP source groups via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /ipSourceGroups, match by name,
 * then PUT an existing group or POST a new one. ZIA STAGES every write — nothing
 * takes effect until activation — so this writes all groups, then calls
 * activate() ONCE at the end. If activation fails the writes remain staged and
 * rollbackData is returned so the platform can revert them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractIpSourceGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: IpSourceGroupRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listIpSourceGroups(client)
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
            ipAddresses: Array.isArray(live.ipAddresses) ? live.ipAddresses : [],
          },
        })
        const res = await client.zia('PUT', `/ipSourceGroups/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update IP source group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/ipSourceGroups', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create IP source group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveIpSourceGroup>(res.body)
        if (created?.id == null) {
          throw new Error(`IP source group "${spec.name}" was created but the API returned no id`)
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
        message: `Staged ${deployed.length} ZIA IP source group(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedGroups: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA IP source group(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `IP source group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA IP source groups; throws on a non-OK response. */
export async function listIpSourceGroups(client: ZscalerClient): Promise<LiveIpSourceGroup[]> {
  const res = await client.ziaGetAll<LiveIpSourceGroup>('/ipSourceGroups')
  if (!res.ok) {
    throw new Error(
      `Failed to list IP source groups: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find an IP source group by name; null when absent. */
export async function findIpSourceGroup(
  client: ZscalerClient,
  name: string,
): Promise<LiveIpSourceGroup | null> {
  const all = await listIpSourceGroups(client)
  return all.find((g) => g.name === name) ?? null
}

function buildPayload(spec: IpSourceGroupSpec): Record<string, unknown> {
  // description always sent (even empty) so clearing it converges the live group.
  return { name: spec.name, description: spec.description ?? '', ipAddresses: spec.ipAddresses }
}
