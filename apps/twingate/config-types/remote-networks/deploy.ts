import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, mutationOkError, type TwingateClient } from '../../lib/twingateApi'
import {
  CREATE_REMOTE_NETWORK_MUTATION,
  LIST_REMOTE_NETWORKS_QUERY,
  UPDATE_REMOTE_NETWORK_MUTATION,
  assertMutationOk,
  buildCreateVariables,
  buildUpdateVariables,
  extractRemoteNetworkSpecs,
  networkKey,
  type LiveRemoteNetwork,
  type RemoteNetworkCreateMutationResponse,
  type RemoteNetworkUpdateMutationResponse,
} from './_shared'

const PAGE_SIZE = 200

export interface RemoteNetworkRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveRemoteNetwork
}

/**
 * Deploy Twingate Remote Networks via the GraphQL API. Identity is the
 * network `name`: list the tenant's remote networks (the list query already
 * carries the full managed state — no per-id read needed), match by name,
 * then update it (capturing its prior state for rollback) or create a new one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractRemoteNetworkSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RemoteNetworkRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listRemoteNetworks(client)
    const byName = new Map(existing.filter((n) => n.name).map((n) => [networkKey(n.name as string), n]))

    for (const spec of specs) {
      const label = spec.name
      const key = networkKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        const liveId: string = live.id
        rollbackState.push({ key, label, existed: true, id: liveId, prior: live })
        const res = await client.graphql<RemoteNetworkUpdateMutationResponse>(
          UPDATE_REMOTE_NETWORK_MUTATION,
          buildUpdateVariables(liveId, spec),
        )
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.remoteNetworkUpdate),
          `update Remote Network "${label}"`,
        )
      } else {
        const res = await client.graphql<RemoteNetworkCreateMutationResponse>(
          CREATE_REMOTE_NETWORK_MUTATION,
          buildCreateVariables(spec),
        )
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.remoteNetworkCreate),
          `create Remote Network "${label}"`,
        )
        const id = res.data?.remoteNetworkCreate?.entity?.id
        if (!id) throw new Error(`Remote Network "${label}" was created but Twingate returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Twingate Remote Network(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedNetworks: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Remote Network deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedNetworks: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all Remote Networks (full managed state); throws on error. */
export async function listRemoteNetworks(client: TwingateClient): Promise<LiveRemoteNetwork[]> {
  const res = await client.listConnection<LiveRemoteNetwork>(LIST_REMOTE_NETWORKS_QUERY, 'remoteNetworks', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Twingate Remote Networks: ${res.error}`)
  return res.nodes
}
