import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, graphqlErrorMessage, mutationOkError, type TwingateClient } from '../../lib/twingateApi'
import {
  CREATE_RESOURCE_MUTATION,
  GET_RESOURCE_QUERY,
  LIST_GROUPS_QUERY,
  LIST_REMOTE_NETWORKS_QUERY,
  LIST_RESOURCES_QUERY,
  UPDATE_RESOURCE_MUTATION,
  assertMutationOk,
  buildCreateVariables,
  buildUpdateVariables,
  byName,
  extractResourceSpecs,
  resourceKey,
  type FullResource,
  type LiveResource,
  type NamedRef,
  type ResourceCreateMutationResponse,
  type ResourceSpec,
  type ResourceUpdateMutationResponse,
} from './_shared'

const PAGE_SIZE = 200

export interface ResourceRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: FullResource
}

interface GetResourceResult {
  resource?: FullResource
}

/**
 * Deploy Twingate Resources via the GraphQL API.
 *
 * Identity is the resource `name`: list the network's resources, match by
 * name, then update it (capturing its prior full state for rollback) or
 * create a new one. `remote_network_name` and `group_names` are resolved to
 * their ids against the live tenant — a name that doesn't resolve aborts the
 * deploy (see README "Design notes" for why this fails closed rather than
 * silently skipping access).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractResourceSpecs(ctx.canvas).filter((s) => s.name && s.address && s.remoteNetworkName)
  const rollbackState: ResourceRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listResources(client)
    const resourcesByName = new Map(
      existing.filter((r) => r.name).map((r) => [resourceKey(r.name as string), r]),
    )

    const remoteNetworks = await listRemoteNetworks(client)
    const networksByName = byName(remoteNetworks)

    const needsGroups = specs.some((s) => s.groupNames.length > 0)
    const groupsByName = needsGroups ? byName(await listGroups(client)) : new Map<string, NamedRef>()

    for (const spec of specs) {
      const label = spec.name
      const key = resourceKey(spec.name)

      const network = networksByName.get(resourceKey(spec.remoteNetworkName))
      if (!network?.id) {
        throw new Error(`Resource "${label}": Remote Network "${spec.remoteNetworkName}" was not found in Twingate`)
      }
      const remoteNetworkId: string = network.id

      const groupIds = resolveGroupIds(spec, label, groupsByName)

      const live = resourcesByName.get(key)
      if (live && live.id) {
        const liveId: string = live.id
        const prior = await readResource(client, liveId)
        rollbackState.push({ key, label, existed: true, id: liveId, prior })
        const res = await client.graphql<ResourceUpdateMutationResponse>(
          UPDATE_RESOURCE_MUTATION,
          buildUpdateVariables(liveId, spec, remoteNetworkId, groupIds),
        )
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.resourceUpdate),
          `update resource "${label}"`,
        )
      } else {
        const res = await client.graphql<ResourceCreateMutationResponse>(
          CREATE_RESOURCE_MUTATION,
          buildCreateVariables(spec, remoteNetworkId, groupIds),
        )
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.resourceCreate),
          `create resource "${label}"`,
        )
        const id = res.data?.resourceCreate?.entity?.id
        if (!id) throw new Error(`Resource "${label}" was created but Twingate returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Twingate resource(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedResources: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Resource deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedResources: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (reused by driftDetect / healthCheck) ----------------------------

/** Resolve a spec's declared group names to ids; throws on any name that doesn't resolve. */
export function resolveGroupIds(spec: ResourceSpec, label: string, groupsByName: Map<string, NamedRef>): string[] {
  const groupIds: string[] = []
  for (const groupName of spec.groupNames) {
    const group = groupsByName.get(resourceKey(groupName))
    if (!group?.id) throw new Error(`Resource "${label}": Group "${groupName}" was not found in Twingate`)
    groupIds.push(group.id as string)
  }
  return groupIds
}

/** List all resources (light shape); throws on error. */
export async function listResources(client: TwingateClient): Promise<LiveResource[]> {
  const res = await client.listConnection<LiveResource>(LIST_RESOURCES_QUERY, 'resources', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Twingate resources: ${res.error}`)
  return res.nodes
}

/** List all Remote Networks; throws on error. */
export async function listRemoteNetworks(client: TwingateClient): Promise<NamedRef[]> {
  const res = await client.listConnection<NamedRef>(LIST_REMOTE_NETWORKS_QUERY, 'remoteNetworks', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Twingate Remote Networks: ${res.error}`)
  return res.nodes
}

/** List all Groups; throws on error. */
export async function listGroups(client: TwingateClient): Promise<NamedRef[]> {
  const res = await client.listConnection<NamedRef>(LIST_GROUPS_QUERY, 'groups', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Twingate Groups: ${res.error}`)
  return res.nodes
}

/** Read one resource's full managed state; throws on error. */
export async function readResource(client: TwingateClient, id: string): Promise<FullResource> {
  const res = await client.graphql<GetResourceResult>(GET_RESOURCE_QUERY, { id })
  if (res.transportError) throw new Error(`Failed to read resource ${id}: ${res.transportError}`)
  if (res.errors) throw new Error(`Failed to read resource ${id}: ${graphqlErrorMessage(res.errors)}`)
  const resource = res.data?.resource
  if (!resource) throw new Error(`Resource ${id} was not found`)
  return resource
}
