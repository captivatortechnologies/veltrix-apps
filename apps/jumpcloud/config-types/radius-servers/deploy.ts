import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, parseJson, JUMPCLOUD_API_BASE, type JumpCloudClient } from '../../lib/jumpcloudApi'
import {
  extractRadiusServerSpecs,
  buildRadiusServerCreateBody,
  buildRadiusServerUpdateBody,
  findRadiusServerByName,
  priorFieldsOf,
  type JumpCloudRadiusServer,
} from './_shared'

/** One rollback record per applied RADIUS server. */
export interface RadiusServerRollbackEntry {
  name: string
  /** Whether the server already existed (update) or was created by this deploy. */
  existed: boolean
  id?: string
  /** Prior managed body (including the true prior sharedSecret — JumpCloud returns it on GET). */
  prior?: Record<string, unknown>
}

/**
 * Deploy JumpCloud RADIUS servers over the API v1 (/radiusservers):
 *   list:   GET  /radiusservers                     ({ results, totalCount } wrapper; match candidates by name)
 *   update: PUT  /radiusservers/{id}  with the RadiusServerPut body (no authIdp)
 *   create: POST /radiusservers       with the RadiusServerPost body (includes authIdp)
 *
 * The name is the stable identity used to upsert. Matching is RENAME-SAFE via the
 * per-item resourceIds map (same pattern as the other JumpCloud config types).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings, { baseUrl: JUMPCLOUD_API_BASE })
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractRadiusServerSpecs(ctx.canvas).filter((s) => s.name)
  const previousState: RadiusServerRollbackEntry[] = []
  const createdIds: string[] = []
  const applied: string[] = []
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const liveServers = await listRadiusServers(client)

    for (const spec of specs) {
      let existing: JumpCloudRadiusServer | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getRadiusServerById(client, priorId)
      if (!existing) existing = findRadiusServerByName(liveServers, spec.name)

      let serverId: string

      if (existing?._id) {
        serverId = existing._id
        previousState.push({ name: spec.name, existed: true, id: serverId, prior: priorFieldsOf(existing) })
        const res = await client.request('PUT', `/radiusservers/${encodeURIComponent(serverId)}`, { body: buildRadiusServerUpdateBody(spec) })
        if (!res.ok) throw new Error(`Failed to update RADIUS Server "${spec.name}": ${jumpCloudErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/radiusservers', { body: buildRadiusServerCreateBody(spec) })
        if (!res.ok) throw new Error(`Failed to create RADIUS Server "${spec.name}": ${jumpCloudErrorMessage(res)}`)
        const created = parseJson<JumpCloudRadiusServer>(res.body)
        if (!created?._id) throw new Error(`RADIUS Server "${spec.name}" was created but the API returned no id`)
        serverId = created._id
        createdIds.push(serverId)
        previousState.push({ name: spec.name, existed: false, id: serverId })
      }

      if (spec.itemId) resourceIds[spec.itemId] = serverId
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} RADIUS Server(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `RADIUS Server deploy failed after ${applied.length} of ${specs.length} server(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every RADIUS server in the org, following pagination over the v1 { results, totalCount } wrapper. */
export async function listRadiusServers(client: JumpCloudClient): Promise<JumpCloudRadiusServer[]> {
  const res = await client.listAllV1<JumpCloudRadiusServer>('/radiusservers')
  if (!res.ok) {
    throw new Error(`Failed to list RADIUS Servers: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch a RADIUS server by id, or null on 404 / any non-ok (a stale stored id falls back to name matching). */
export async function getRadiusServerById(client: JumpCloudClient, id: string): Promise<JumpCloudRadiusServer | null> {
  const res = await client.request('GET', `/radiusservers/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const server = parseJson<JumpCloudRadiusServer>(res.body)
  return server?._id ? server : null
}

/**
 * Read the canvas-item-id -> server-id map this canvas stored on its last
 * SUCCEEDED deploy (rollbackData.resourceIds). Best-effort — {} on no prior
 * deploy or a read error.
 */
async function readPriorResourceIds(ctx: DeployContext): Promise<Record<string, string>> {
  try {
    const prior = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const rb = prior?.rollbackData as { resourceIds?: Record<string, string> } | undefined
    return rb?.resourceIds ?? {}
  } catch {
    return {}
  }
}
