import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAutomoxClient, automoxErrorMessage, parseJson, type AutomoxClient } from '../../lib/automoxApi'
import { extractServerGroupSpecs, buildServerGroupBody, findServerGroupByName, priorServerGroupFieldsOf, type AutomoxServerGroup } from './_shared'

/** One rollback record per applied server group. */
export interface ServerGroupRollbackEntry {
  name: string
  /** Whether the group already existed (update) or was created by this deploy. */
  existed: boolean
  id?: number
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/**
 * Deploy Automox Server Groups over the Console API (`/servergroups`),
 * org-scoped via `o=<organizationId>`:
 *   list:   GET  /servergroups                (paged; match candidates by name)
 *   update: PUT  /servergroups/{id}           with the full managed group body (204, no body)
 *   create: POST /servergroups                with the full managed group body
 *
 * Unlike `POST /policies`, `POST /servergroups` returns 200 with the FULL
 * created object (including its id) — no list-and-match id-resolution
 * workaround is needed here.
 *
 * The name is the stable identity used to upsert. Matching is RENAME-SAFE via
 * the per-item resourceIds map (same pattern used by the `policies` /
 * `worklets` config types).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildAutomoxClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractServerGroupSpecs(ctx.canvas).filter((s) => s.name)
  const previousState: ServerGroupRollbackEntry[] = []
  const createdIds: number[] = []
  const applied: string[] = []
  const resourceIds: Record<string, number> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const liveGroups = await listServerGroups(client)

    for (const spec of specs) {
      const body = buildServerGroupBody(spec)

      // Match order: (1) the id stored for this canvas item on the last
      // deploy (rename-safe), (2) by name for the first deploy / a stale id.
      let existing: AutomoxServerGroup | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getServerGroupById(client, priorId)
      if (!existing) existing = findServerGroupByName(liveGroups, spec.name)

      let groupId: number
      if (existing?.id) {
        groupId = existing.id
        const detailed = (await getServerGroupById(client, groupId)) ?? existing
        previousState.push({ name: spec.name, existed: true, id: groupId, prior: priorServerGroupFieldsOf(detailed) })
        const res = await client.request('PUT', `/servergroups/${groupId}`, { body })
        if (!res.ok) throw new Error(`Failed to update Server Group "${spec.name}": ${automoxErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/servergroups', { body })
        if (!res.ok) throw new Error(`Failed to create Server Group "${spec.name}": ${automoxErrorMessage(res)}`)
        const created = parseJson<AutomoxServerGroup>(res.body)
        if (!created?.id) {
          throw new Error(`Server Group "${spec.name}" was created but Automox returned no id.`)
        }
        groupId = created.id
        createdIds.push(groupId)
        previousState.push({ name: spec.name, existed: false, id: groupId })
      }

      if (spec.itemId) resourceIds[spec.itemId] = groupId
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Server Group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { organizationId: client.orgId, applied },
      rollbackData: { previousState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Server Group deploy failed after ${applied.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { organizationId: client.orgId, applied },
      rollbackData: { previousState, createdIds, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every Server Group in the org, following pagination. */
export async function listServerGroups(client: AutomoxClient): Promise<AutomoxServerGroup[]> {
  const res = await client.listAllPaged<AutomoxServerGroup>('/servergroups')
  if (!res.ok) {
    throw new Error(`Failed to list Server Groups: ${automoxErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch a server group by id, or null on 404 / any non-ok. */
export async function getServerGroupById(client: AutomoxClient, id: number): Promise<AutomoxServerGroup | null> {
  const res = await client.request('GET', `/servergroups/${id}`)
  if (!res.ok) return null
  const group = parseJson<AutomoxServerGroup>(res.body)
  return group?.id ? group : null
}

/**
 * Read the canvas-item-id -> group-id map this canvas stored on its last
 * SUCCEEDED deploy (rollbackData.resourceIds). Best-effort — {} on no prior
 * deploy or a read error.
 */
async function readPriorResourceIds(ctx: DeployContext): Promise<Record<string, number>> {
  try {
    const prior = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const rb = prior?.rollbackData as { resourceIds?: Record<string, number> } | undefined
    return rb?.resourceIds ?? {}
  } catch {
    return {}
  }
}
