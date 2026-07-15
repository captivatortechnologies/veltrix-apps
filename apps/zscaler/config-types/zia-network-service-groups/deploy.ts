import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractServiceGroupSpecs,
  type LiveServiceGroup,
  type ServiceGroupSpec,
} from './validate'

/** Shape of a network service returned by GET /networkServices (id + name). */
export interface LiveNetworkService {
  id?: number
  name?: string
  type?: string
}

export interface ServiceGroupRollbackEntry {
  name: string
  existed: boolean
  id?: number
  prior?: { name?: string; description?: string; services?: Array<{ id: number }> }
}

/**
 * Deploy ZIA network service groups via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /networkServiceGroups, match by
 * name, then PUT an existing group or POST a new one. Member services are
 * referenced by NAME in the canvas, so this lists /networkServices ONCE up front
 * and resolves each member name to its id — an unknown name fails the deploy.
 * ZIA STAGES every write — nothing takes effect until activation — so this
 * writes all groups, then calls activate() ONCE at the end. If activation fails
 * the writes remain staged and rollbackData is returned so the platform can
 * revert them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractServiceGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ServiceGroupRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    // Resolve member service NAMES → ids from the live tenant, once.
    const serviceIdByName = await buildServiceNameIndex(client)

    const existing = await listServiceGroups(client)
    const byName = new Map(existing.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const memberIds = resolveServiceIds(spec, serviceIdByName)
      const live = byName.get(spec.name)

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: live.name,
            description: live.description ?? '',
            services: (live.services ?? [])
              .filter((s) => s.id != null)
              .map((s) => ({ id: s.id as number })),
          },
        })
        const res = await client.zia('PUT', `/networkServiceGroups/${live.id}`, {
          body: buildPayload(spec, memberIds),
        })
        if (!res.ok) {
          throw new Error(`Failed to update network service group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/networkServiceGroups', {
          body: buildPayload(spec, memberIds),
        })
        if (!res.ok) {
          throw new Error(`Failed to create network service group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveServiceGroup>(res.body)
        if (created?.id == null) {
          throw new Error(`Network service group "${spec.name}" was created but the API returned no id`)
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
        message: `Staged ${deployed.length} ZIA network service group(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedGroups: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA network service group(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network service group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA network service groups; throws on a non-OK response. */
export async function listServiceGroups(client: ZscalerClient): Promise<LiveServiceGroup[]> {
  const res = await client.ziaGetAll<LiveServiceGroup>('/networkServiceGroups')
  if (!res.ok) {
    throw new Error(
      `Failed to list network service groups: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** List all ZIA network services; throws on a non-OK response. */
export async function listNetworkServices(client: ZscalerClient): Promise<LiveNetworkService[]> {
  const res = await client.ziaGetAll<LiveNetworkService>('/networkServices')
  if (!res.ok) {
    throw new Error(
      `Failed to list network services: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a network service group by name; null when absent. */
export async function findServiceGroup(
  client: ZscalerClient,
  name: string,
): Promise<LiveServiceGroup | null> {
  const all = await listServiceGroups(client)
  return all.find((g) => g.name === name) ?? null
}

/** Build a name → id index of every live network service. */
async function buildServiceNameIndex(client: ZscalerClient): Promise<Map<string, number>> {
  const services = await listNetworkServices(client)
  const index = new Map<string, number>()
  for (const svc of services) {
    if (svc.name && svc.id != null) index.set(svc.name, svc.id)
  }
  return index
}

/** Resolve a spec's member service names to ids; throws on the first unknown name. */
function resolveServiceIds(spec: ServiceGroupSpec, index: Map<string, number>): number[] {
  return spec.services.map((serviceName) => {
    const id = index.get(serviceName)
    if (id == null) {
      throw new Error(
        `Network service group "${spec.name}" references network service "${serviceName}", which does not exist in the tenant — create it first or correct the name`,
      )
    }
    return id
  })
}

function buildPayload(spec: ServiceGroupSpec, memberIds: number[]): Record<string, unknown> {
  // description always sent (even empty) so clearing it converges the live group.
  return {
    name: spec.name,
    description: spec.description ?? '',
    services: memberIds.map((id) => ({ id })),
  }
}
