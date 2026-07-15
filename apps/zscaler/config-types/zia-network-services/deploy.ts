import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractNetworkServiceSpecs,
  type LiveNetworkService,
  type NetworkServiceSpec,
  type PortRange,
} from './validate'

export interface NetworkServiceRollbackEntry {
  name: string
  existed: boolean
  id?: number
  prior?: {
    name?: string
    description?: string
    type?: string
    destTcpPorts?: PortRange[]
    destUdpPorts?: PortRange[]
  }
}

/**
 * Deploy custom ZIA network services via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /networkServices, match by
 * name, then PUT an existing service or POST a new one. ZIA STAGES every write —
 * nothing takes effect until activation — so this writes all services, then
 * calls activate() ONCE at the end. If activation fails the writes remain staged
 * and rollbackData is returned so the platform can revert them.
 *
 * PREDEFINED (built-in) network services are read-only: if a name matches a live
 * service whose type is "PREDEFINED", deploy throws so the author renames rather
 * than attempting to overwrite a built-in.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractNetworkServiceSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: NetworkServiceRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listNetworkServices(client)
    const byName = new Map(existing.filter((s) => s.name).map((s) => [s.name as string, s]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && (live.type ?? '').toUpperCase() === 'PREDEFINED') {
        throw new Error(
          `"${spec.name}" is a predefined network service and cannot be modified — rename your service to manage a custom one`,
        )
      }

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: live.name,
            description: live.description ?? '',
            type: live.type,
            destTcpPorts: live.destTcpPorts,
            destUdpPorts: live.destUdpPorts,
          },
        })
        const res = await client.zia('PUT', `/networkServices/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update network service "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/networkServices', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create network service "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveNetworkService>(res.body)
        if (created?.id == null) {
          throw new Error(`Network service "${spec.name}" was created but the API returned no id`)
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
        message: `Staged ${deployed.length} ZIA network service(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedServices: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA network service(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedServices: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network service deployment failed after ${deployed.length} of ${specs.length} service(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedServices: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

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

/** Find a network service by name; null when absent. */
export async function findNetworkService(
  client: ZscalerClient,
  name: string,
): Promise<LiveNetworkService | null> {
  const all = await listNetworkServices(client)
  return all.find((s) => s.name === name) ?? null
}

function buildPayload(spec: NetworkServiceSpec): Record<string, unknown> {
  // description always sent (even empty) so clearing it converges the live service.
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
    type: 'CUSTOM',
  }
  if (spec.tcpPorts.length > 0) body.destTcpPorts = spec.tcpPorts
  if (spec.udpPorts.length > 0) body.destUdpPorts = spec.udpPorts
  return body
}
