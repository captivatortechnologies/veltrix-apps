import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractDestinationGroupSpecs,
  type DestinationGroupSpec,
  type LiveDestinationGroup,
} from './validate'

export interface DestinationGroupRollbackEntry {
  name: string
  existed: boolean
  id?: number
  prior?: {
    name?: string
    description?: string
    type?: string
    addresses?: string[]
    countries?: string[]
  }
}

/**
 * Deploy ZIA IP destination groups via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /ipDestinationGroups, match by
 * name, then PUT an existing group or POST a new one. ZIA STAGES every write —
 * nothing takes effect until activation — so this writes all groups, then calls
 * activate() ONCE at the end. If activation fails the writes remain staged and
 * rollbackData is returned so the platform can revert them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractDestinationGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: DestinationGroupRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listDestinationGroups(client)
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
            type: live.type,
            addresses: Array.isArray(live.addresses) ? live.addresses : [],
            countries: Array.isArray(live.countries) ? live.countries : [],
          },
        })
        const res = await client.zia('PUT', `/ipDestinationGroups/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update destination group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/ipDestinationGroups', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create destination group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveDestinationGroup>(res.body)
        if (created?.id == null) {
          throw new Error(`Destination group "${spec.name}" was created but the API returned no id`)
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
        message: `Staged ${deployed.length} ZIA IP destination group(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedGroups: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA IP destination group(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `IP destination group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA IP destination groups; throws on a non-OK response. */
export async function listDestinationGroups(client: ZscalerClient): Promise<LiveDestinationGroup[]> {
  const res = await client.ziaGetAll<LiveDestinationGroup>('/ipDestinationGroups')
  if (!res.ok) {
    throw new Error(
      `Failed to list IP destination groups: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find an IP destination group by name; null when absent. */
export async function findDestinationGroup(
  client: ZscalerClient,
  name: string,
): Promise<LiveDestinationGroup | null> {
  const all = await listDestinationGroups(client)
  return all.find((g) => g.name === name) ?? null
}

function buildPayload(spec: DestinationGroupSpec): Record<string, unknown> {
  // description always sent (even empty) so clearing it converges the live group.
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
    type: spec.type,
    addresses: spec.addresses,
  }
  if (spec.countries && spec.countries.length > 0) {
    body.countries = spec.countries
  }
  return body
}
