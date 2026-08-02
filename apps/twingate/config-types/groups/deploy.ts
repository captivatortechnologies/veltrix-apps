import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, mutationOkError, type TwingateClient } from '../../lib/twingateApi'
import {
  CREATE_GROUP_MUTATION,
  LIST_GROUPS_QUERY,
  LIST_RESOURCES_QUERY,
  UPDATE_GROUP_MUTATION,
  assertMutationOk,
  buildGroupCreateVariables,
  buildGroupUpdateVariables,
  extractGroupSpecs,
  groupKey,
  isExternallyManaged,
  type GroupCreateMutationResponse,
  type GroupSpec,
  type GroupUpdateMutationResponse,
  type LiveGroup,
  type NamedRef,
} from './_shared'

const PAGE_SIZE = 200

export interface GroupRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveGroup
}

/**
 * Deploy Twingate Groups via the GraphQL API.
 *
 * Identity is the group `name`, matched ONLY among MANUAL groups (SYNCED/
 * SYSTEM groups are Twingate/IdP-owned and are never matched or modified — a
 * name collision with one of those aborts the deploy rather than silently
 * skipping or duplicating). `resource_names` are resolved to `resourceIds`
 * against the live tenant; a name that doesn't resolve also aborts the deploy.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: GroupRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existingGroups = await listGroups(client)
    const allByName = new Map(existingGroups.filter((g) => g.name).map((g) => [groupKey(g.name as string), g]))

    const needsResources = specs.some((s) => s.resourceNames.length > 0)
    const resourcesByName = needsResources ? indexByName(await listResources(client)) : new Map<string, NamedRef>()

    for (const spec of specs) {
      const label = spec.name
      const key = groupKey(spec.name)

      const resourceIds = resolveResourceIds(spec, label, resourcesByName)

      const found = allByName.get(key)
      if (found && isExternallyManaged(found.type)) {
        throw new Error(
          `Group "${label}" already exists in Twingate as a ${found.type} group and cannot be managed by Veltrix ` +
            '(SYNCED groups come from an IdP; SYSTEM groups are Twingate built-ins). Rename this item or remove it.',
        )
      }

      if (found && found.id) {
        const foundId: string = found.id
        rollbackState.push({ key, label, existed: true, id: foundId, prior: found })
        const res = await client.graphql<GroupUpdateMutationResponse>(
          UPDATE_GROUP_MUTATION,
          buildGroupUpdateVariables(foundId, spec, resourceIds),
        )
        assertMutationOk(res.transportError, res.errors, mutationOkError(res.data?.groupUpdate), `update Group "${label}"`)
      } else {
        const res = await client.graphql<GroupCreateMutationResponse>(
          CREATE_GROUP_MUTATION,
          buildGroupCreateVariables(spec, resourceIds),
        )
        assertMutationOk(res.transportError, res.errors, mutationOkError(res.data?.groupCreate), `create Group "${label}"`)
        const id = res.data?.groupCreate?.entity?.id
        if (!id) throw new Error(`Group "${label}" was created but Twingate returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Twingate Group(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Group deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (reused by driftDetect / healthCheck) ----------------------------

/** Resolve a spec's declared resource names to ids; throws on any name that doesn't resolve. */
export function resolveResourceIds(spec: GroupSpec, label: string, resourcesByName: Map<string, NamedRef>): string[] {
  const ids: string[] = []
  for (const resourceName of spec.resourceNames) {
    const resource = resourcesByName.get(groupKey(resourceName))
    if (!resource?.id) throw new Error(`Group "${label}": Resource "${resourceName}" was not found in Twingate`)
    ids.push(resource.id)
  }
  return ids
}

function indexByName(refs: NamedRef[]): Map<string, NamedRef> {
  return new Map(refs.filter((r) => r.name && r.id).map((r) => [groupKey(r.name as string), r]))
}

/** List all Groups (with their current Resource access); throws on error. */
export async function listGroups(client: TwingateClient): Promise<LiveGroup[]> {
  const res = await client.listConnection<LiveGroup>(LIST_GROUPS_QUERY, 'groups', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Twingate Groups: ${res.error}`)
  return res.nodes
}

/** List all Resources (light shape); throws on error. */
export async function listResources(client: TwingateClient): Promise<NamedRef[]> {
  const res = await client.listConnection<NamedRef>(LIST_RESOURCES_QUERY, 'resources', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Twingate Resources: ${res.error}`)
  return res.nodes
}
