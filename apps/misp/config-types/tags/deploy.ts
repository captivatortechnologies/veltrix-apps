import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { buildTagFields, tagsFromList, findTag, type MispTag } from './_shared'

/**
 * Deploy MISP tags over the REST API (443):
 *   read (rollback): GET  /tags/index          → find the live tag by name
 *   create:          POST /tags/add             with { Tag: {...} }
 *   update:          POST /tags/edit/<id>        with { Tag: {...} } (tag exists)
 *
 * The name is the stable identity used to upsert — MISP enforces tag-name
 * uniqueness, and TagsController::add() silently returns the existing tag
 * (WITHOUT applying new field values) when the name already exists, so this
 * always resolves the live list first and routes to edit for anything found.
 * rollbackData records, per tag, the prior tag body (null when it did not
 * exist) AND the tag id — a prior body restores via edit; a newly created tag
 * (no prior body) is hard-deleted on rollback via /tags/delete/<id>.
 *
 * NOTE: verify /tags/index + /tags/add + /tags/edit/<id> + /tags/delete/<id>
 * against a live MISP 2.4 instance.
 */
interface TagMutationResponse {
  Tag?: MispTag
}

async function listTags(base: string, headers: Record<string, string>): Promise<MispTag[]> {
  try {
    return tagsFromList(await getJson<unknown>(`${base}/tags/index`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for tag deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; tagId: number | string | null; tag: MispTag | null }> = []
  const applied: string[] = []

  try {
    const live = await listTags(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findTag(live, name)
      const body = { Tag: buildTagFields(item.fields) }

      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/tags/edit/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, tagId: existing.id, tag: existing })
      } else {
        const created = await sendJson<TagMutationResponse>('POST', `${base}/tags/add`, headers, body)
        const newId = created?.Tag?.id ?? null
        previous.push({ name, tagId: newId, tag: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} tag(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Tag deploy failed after ${applied.length} tag(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
