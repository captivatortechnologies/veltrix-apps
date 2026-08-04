import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, mutationOkError, type TwingateClient } from '../../lib/twingateApi'
import {
  CREATE_CONNECTOR_MUTATION,
  LIST_CONNECTORS_QUERY,
  LIST_REMOTE_NETWORKS_QUERY,
  UPDATE_CONNECTOR_MUTATION,
  assertMutationOk,
  buildCreateVariables,
  buildUpdateVariables,
  byName,
  connectorKey,
  extractConnectorSpecs,
  type ConnectorCreateMutationResponse,
  type ConnectorUpdateMutationResponse,
  type LiveConnector,
  type NamedRef,
} from './_shared'

const PAGE_SIZE = 200

export interface ConnectorRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveConnector
}

/**
 * Deploy Twingate Connectors via the GraphQL API. Identity is the connector
 * `name`: list the tenant's connectors, match by name, then update it
 * (capturing its prior state for rollback) or create a new one.
 *
 * A Connector's Remote Network is set on create only (`connectorUpdate` has
 * no such argument) — if an existing connector's live Remote Network no
 * longer matches the declared one, this fails closed rather than silently
 * ignoring the change.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractConnectorSpecs(ctx.canvas).filter((s) => s.name && s.remoteNetworkName)
  const rollbackState: ConnectorRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listConnectors(client)
    const byNameMap = new Map(existing.filter((c) => c.name).map((c) => [connectorKey(c.name as string), c]))

    const networksByName = byName(await listRemoteNetworks(client))

    for (const spec of specs) {
      const label = spec.name
      const key = connectorKey(spec.name)

      const network = networksByName.get(connectorKey(spec.remoteNetworkName))
      if (!network?.id) {
        throw new Error(`Connector "${label}": Remote Network "${spec.remoteNetworkName}" was not found in Twingate`)
      }
      const remoteNetworkId: string = network.id

      const live = byNameMap.get(key)
      if (live && live.id) {
        const liveId: string = live.id
        if ((live.remoteNetwork?.id ?? '') !== remoteNetworkId) {
          throw new Error(
            `Connector "${label}" already exists attached to a different Remote Network in Twingate. ` +
              'Twingate has no mutation to reassign a Connector\'s Remote Network — delete and recreate it ' +
              '(and re-generate its token) or rename this item to create a new Connector alongside it.',
          )
        }
        rollbackState.push({ key, label, existed: true, id: liveId, prior: live })
        const res = await client.graphql<ConnectorUpdateMutationResponse>(UPDATE_CONNECTOR_MUTATION, buildUpdateVariables(liveId, spec))
        assertMutationOk(res.transportError, res.errors, mutationOkError(res.data?.connectorUpdate), `update Connector "${label}"`)
      } else {
        const res = await client.graphql<ConnectorCreateMutationResponse>(
          CREATE_CONNECTOR_MUTATION,
          buildCreateVariables(spec, remoteNetworkId),
        )
        assertMutationOk(res.transportError, res.errors, mutationOkError(res.data?.connectorCreate), `create Connector "${label}"`)
        const id = res.data?.connectorCreate?.entity?.id
        if (!id) throw new Error(`Connector "${label}" was created but Twingate returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Twingate Connector(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedConnectors: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Connector deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedConnectors: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all Connectors; throws on error. */
export async function listConnectors(client: TwingateClient): Promise<LiveConnector[]> {
  const res = await client.listConnection<LiveConnector>(LIST_CONNECTORS_QUERY, 'connectors', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Twingate Connectors: ${res.error}`)
  return res.nodes
}

/** List all Remote Networks (light shape); throws on error. */
export async function listRemoteNetworks(client: TwingateClient): Promise<NamedRef[]> {
  const res = await client.listConnection<NamedRef>(LIST_REMOTE_NETWORKS_QUERY, 'remoteNetworks', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Twingate Remote Networks: ${res.error}`)
  return res.nodes
}
