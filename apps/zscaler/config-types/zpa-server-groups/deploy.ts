import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  MISSING_CUSTOMER_ID_MESSAGE,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractServerGroupSpecs, type LiveServerGroup, type ServerGroupSpec } from './validate'

/** Shape of an App Connector group returned by GET /appConnectorGroup (id + name). */
export interface LiveAppConnectorGroup {
  id?: string
  name?: string
}

/** Shape of a server returned by GET /server (id + name). */
export interface LiveServer {
  id?: string
  name?: string
}

export interface ServerGroupRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
    dynamicDiscovery?: boolean
    appConnectorGroups?: Array<{ id: string }>
    servers?: Array<{ id: string }>
  }
}

/**
 * Deploy ZPA server groups via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZPA has no upsert): list /serverGroup, match by name,
 * then PUT an existing group or POST a new one. A server group binds App
 * Connector groups (always) and, when dynamic discovery is OFF, explicit servers
 * — both referenced by NAME in the canvas — so this lists /appConnectorGroup
 * (and /server, only when a group needs it) ONCE up front and resolves each name
 * to its id; an unknown name fails the deploy (create the dependency first).
 * Unlike ZIA, ZPA changes apply IMMEDIATELY — there is no activation step, so a
 * write returning success is the end of the operation.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built
  if (!client.hasCustomerId) {
    return { success: false, message: MISSING_CUSTOMER_ID_MESSAGE }
  }

  const specs = extractServerGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ServerGroupRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    // Resolve referenced App Connector group NAMES → ids from the live tenant,
    // once. Servers are only needed for groups with dynamic discovery disabled.
    const appConnectorGroupIndex = await buildAppConnectorGroupIndex(client)
    const needsServers = specs.some((s) => !s.dynamicDiscovery)
    const serverIndex = needsServers ? await buildServerIndex(client) : new Map<string, string>()

    const existing = await listServerGroups(client)
    const byName = new Map(existing.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const appConnectorGroupIds = resolveAppConnectorGroupIds(spec, appConnectorGroupIndex)
      const serverIds = spec.dynamicDiscovery ? [] : resolveServerIds(spec, serverIndex)
      const live = byName.get(spec.name)

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: live.name,
            description: live.description ?? '',
            enabled: live.enabled ?? true,
            dynamicDiscovery: live.dynamicDiscovery ?? true,
            appConnectorGroups: (live.appConnectorGroups ?? [])
              .filter((g) => g.id != null)
              .map((g) => ({ id: g.id as string })),
            servers: (live.servers ?? [])
              .filter((s) => s.id != null)
              .map((s) => ({ id: s.id as string })),
          },
        })
        const res = await client.zpa('PUT', `/serverGroup/${live.id}`, {
          body: buildPayload(spec, appConnectorGroupIds, serverIds, live.id),
        })
        if (!res.ok) {
          throw new Error(`Failed to update server group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zpa('POST', '/serverGroup', {
          body: buildPayload(spec, appConnectorGroupIds, serverIds),
        })
        if (!res.ok) {
          throw new Error(`Failed to create server group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveServerGroup>(res.body)
        if (created?.id == null) {
          throw new Error(`Server group "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ZPA server group(s) on tenant "${vanity}": ${deployed.join(', ')}`,
      artifacts: { vanity, deployedServerGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Server group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedServerGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZPA server groups; throws on a non-OK response. */
export async function listServerGroups(client: ZscalerClient): Promise<LiveServerGroup[]> {
  const res = await client.zpaGetAll<LiveServerGroup>('/serverGroup')
  if (!res.ok) {
    throw new Error(`Failed to list server groups: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** Build a name → id index of every live App Connector group. */
async function buildAppConnectorGroupIndex(client: ZscalerClient): Promise<Map<string, string>> {
  const res = await client.zpaGetAll<LiveAppConnectorGroup>('/appConnectorGroup')
  if (!res.ok) {
    throw new Error(
      `Failed to list App Connector groups: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  const index = new Map<string, string>()
  for (const group of res.items) {
    if (group.name && group.id != null) index.set(group.name, group.id)
  }
  return index
}

/** Build a name → id index of every live ZPA server. */
async function buildServerIndex(client: ZscalerClient): Promise<Map<string, string>> {
  const res = await client.zpaGetAll<LiveServer>('/server')
  if (!res.ok) {
    throw new Error(`Failed to list servers: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  const index = new Map<string, string>()
  for (const server of res.items) {
    if (server.name && server.id != null) index.set(server.name, server.id)
  }
  return index
}

/** Resolve a spec's App Connector group names to ids; throws on the first unknown name. */
function resolveAppConnectorGroupIds(spec: ServerGroupSpec, index: Map<string, string>): string[] {
  return spec.appConnectorGroups.map((groupName) => {
    const id = index.get(groupName)
    if (id == null) {
      throw new Error(
        `Server group "${spec.name}" references App Connector group "${groupName}", which does not exist in the tenant — create it first or correct the name`,
      )
    }
    return id
  })
}

/**
 * Resolve a spec's server names to ids; throws on the first unknown name, and on
 * an empty result (dynamic discovery is off, so the group must have ≥1 server).
 */
function resolveServerIds(spec: ServerGroupSpec, index: Map<string, string>): string[] {
  const ids = spec.servers.map((serverName) => {
    const id = index.get(serverName)
    if (id == null) {
      throw new Error(
        `Server group "${spec.name}" references server "${serverName}", which does not exist in the tenant — create it first or correct the name`,
      )
    }
    return id
  })
  if (ids.length === 0) {
    throw new Error(
      `Server group "${spec.name}" has dynamic discovery disabled and must list at least one server`,
    )
  }
  return ids
}

function buildPayload(
  spec: ServerGroupSpec,
  appConnectorGroupIds: string[],
  serverIds: string[],
  id?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
    enabled: spec.enabled,
    dynamicDiscovery: spec.dynamicDiscovery,
    appConnectorGroups: appConnectorGroupIds.map((gid) => ({ id: gid })),
  }
  // Explicit servers only apply when dynamic discovery is off; ZPA rejects them
  // when discovery is on.
  if (!spec.dynamicDiscovery) {
    payload.servers = serverIds.map((sid) => ({ id: sid }))
  }
  // PUT is replace-style — echo the id back so the record is fully specified.
  if (id != null) payload.id = id
  return payload
}
