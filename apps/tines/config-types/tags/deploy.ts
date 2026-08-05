import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage, parseJson, type TinesClient } from '../../lib/tinesApi'
import { buildTagCreateBody, buildTagUpdateBody, extractTagSpecs, findTag, type LiveTag } from './_shared'

/** Per-tag rollback record captured during deploy. */
export interface TagRollbackEntry {
  itemName: string
  name: string
  teamId: string
  existed: boolean
  id?: string
  prior?: LiveTag
}

/**
 * Deploy Tines tags over the REST API — upsert by (team, name):
 *   read (rollback): GET  /api/v1/tags?team_id=
 *   create:          POST /api/v1/tags        <- { name, team_id, color }
 *   update:          PUT  /api/v1/tags/{id}     <- { name, color }
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractTagSpecs(ctx.canvas).filter((s) => s.name && s.teamId && s.color)
  const rollbackState: TagRollbackEntry[] = []
  const deployed: string[] = []
  const liveByTeam = new Map<string, LiveTag[]>()

  try {
    for (const spec of specs) {
      let live = liveByTeam.get(spec.teamId)
      if (!live) {
        live = await listTags(client, spec.teamId)
        liveByTeam.set(spec.teamId, live)
      }

      const match = findTag(live, spec.teamId, spec.name)
      if (match && match.id !== undefined) {
        rollbackState.push({ itemName: spec.itemName, name: spec.name, teamId: spec.teamId, existed: true, id: String(match.id), prior: match })
        const res = await client.request('PUT', `/tags/${match.id}`, { body: buildTagUpdateBody(spec) })
        if (!res.ok) throw new Error(`Failed to update tag "${spec.name}": ${tinesErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/tags', { body: buildTagCreateBody(spec) })
        if (!res.ok) throw new Error(`Failed to create tag "${spec.name}": ${tinesErrorMessage(res)}`)
        const created = parseJson<LiveTag>(res.body)
        if (!created?.id) throw new Error(`Tag "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ itemName: spec.itemName, name: spec.name, teamId: spec.teamId, existed: false, id: String(created.id) })
        live.push(created)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} tag(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Tag deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List all tags scoped to a team; throws on a non-OK response. */
export async function listTags(client: TinesClient, teamId: string): Promise<LiveTag[]> {
  const res = await client.getAll<LiveTag>('/tags', 'tags', { team_id: teamId })
  if (!res.ok) {
    throw new Error(`Failed to list tags: ${tinesErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
