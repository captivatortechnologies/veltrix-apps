import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient, type KandjiClient } from '../../lib/kandjiApi'
import { buildTagBody, tagKey, extractTagSpecs, indexTagsByName, type LiveTag } from './validate'

const TAGS_PATH = '/api/v1/tags'

export interface TagRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveTag
}

interface CreateTagResponse {
  id?: string
}

/** List every tag in the tenant, following pagination to completion. */
export async function listTags(client: KandjiClient): Promise<LiveTag[]> {
  const res = await client.listAll<LiveTag>(TAGS_PATH)
  if (res.error) throw new Error(`Failed to list Kandji tags: ${res.error}`)
  return res.nodes
}

/**
 * Deploy Kandji tags via the tenant API. Identity is the tag `name`: list,
 * match, create missing / update existing one at a time (Kandji's own docs
 * note POST "can only create one tag per request").
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractTagSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: TagRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listTags(client)
    const byName = indexTagsByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = tagKey(spec.name)
      const live = byName.get(key)
      const body = buildTagBody(spec)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PATCH', `${TAGS_PATH}/${encodeURIComponent(live.id)}`, { body })
        if (res.error) throw new Error(`Failed to update tag "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.request<CreateTagResponse>('POST', TAGS_PATH, { body })
        if (res.error) throw new Error(`Failed to create tag "${label}": ${res.error}`)
        const id = res.data?.id
        if (!id) throw new Error(`Tag "${label}" was created but Kandji returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} Kandji tag(s) on ${baseUrl}: ${created.length} created, ${updated.length} updated.`,
      artifacts: { baseUrl, createdTags: created, updatedTags: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Tag deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, createdTags: created, updatedTags: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}
