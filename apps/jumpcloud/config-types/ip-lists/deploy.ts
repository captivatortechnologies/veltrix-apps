import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, parseJson, type JumpCloudClient } from '../../lib/jumpcloudApi'
import {
  extractIpListSpecs,
  buildIpListBody,
  findIpListByName,
  priorFieldsOf,
  type JumpCloudIpList,
} from './_shared'

/** One rollback record per applied IP List. */
export interface IpListRollbackEntry {
  name: string
  /** Whether the list already existed (update) or was created by this deploy. */
  existed: boolean
  id?: string
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/**
 * Deploy JumpCloud IP Lists over the API v2 (/iplists):
 *   list:   GET  /iplists                     (paged; match candidates by name)
 *   update: PUT  /iplists/{id}  with { name, description, ips }  (full replace)
 *   create: POST /iplists       with { name, description, ips }
 *
 * The name is the stable identity used to upsert. Matching is RENAME-SAFE via the
 * per-item resourceIds map (same pattern as the other JumpCloud config types).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractIpListSpecs(ctx.canvas).filter((s) => s.name)
  const previousState: IpListRollbackEntry[] = []
  const createdIds: string[] = []
  const applied: string[] = []
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const liveLists = await listIpLists(client)

    for (const spec of specs) {
      let existing: JumpCloudIpList | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getIpListById(client, priorId)
      if (!existing) existing = findIpListByName(liveLists, spec.name)

      const body = buildIpListBody(spec)
      let listId: string

      if (existing?.id) {
        listId = existing.id
        previousState.push({ name: spec.name, existed: true, id: listId, prior: priorFieldsOf(existing) })
        const res = await client.request('PUT', `/iplists/${encodeURIComponent(listId)}`, { body })
        if (!res.ok) throw new Error(`Failed to update IP List "${spec.name}": ${jumpCloudErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/iplists', { body })
        if (!res.ok) throw new Error(`Failed to create IP List "${spec.name}": ${jumpCloudErrorMessage(res)}`)
        const created = parseJson<JumpCloudIpList>(res.body)
        if (!created?.id) throw new Error(`IP List "${spec.name}" was created but the API returned no id`)
        listId = created.id
        createdIds.push(listId)
        previousState.push({ name: spec.name, existed: false, id: listId })
      }

      if (spec.itemId) resourceIds[spec.itemId] = listId
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} IP List(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `IP List deploy failed after ${applied.length} of ${specs.length} list(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every IP List in the org, following pagination. */
export async function listIpLists(client: JumpCloudClient): Promise<JumpCloudIpList[]> {
  const res = await client.listAll<JumpCloudIpList>('/iplists')
  if (!res.ok) {
    throw new Error(`Failed to list IP Lists: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch an IP List by id, or null on 404 / any non-ok (a stale stored id falls back to name matching). */
export async function getIpListById(client: JumpCloudClient, id: string): Promise<JumpCloudIpList | null> {
  const res = await client.request('GET', `/iplists/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const list = parseJson<JumpCloudIpList>(res.body)
  return list?.id ? list : null
}

/**
 * Read the canvas-item-id -> IP-List-id map this canvas stored on its last
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
