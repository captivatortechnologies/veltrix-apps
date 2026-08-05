import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, listAll, getJson, sendJson } from '../../lib/soarApi'
import { buildListSpec, findListByName, parseFormattedContent, type SoarCustomList } from './_shared'

/**
 * Deploy custom lists over the SOAR REST API (443):
 *   read (upsert lookup): GET  /rest/decided_list?page_size=0 → find the live list by name
 *   read (prior content): GET  /rest/decided_list/<id>/formatted_content?_output_format=json
 *   create:                POST /rest/decided_list             with { name, content }
 *   update:                POST /rest/decided_list/<id>          with { content } — REPLACES
 *                          the full list content (not a row append/patch)
 *
 * rollbackData records, per list, its numeric id and prior content (null when
 * newly created, or when the prior content couldn't be read) — a prior
 * content restores via POST /<id>; a newly-created list is deleted on
 * rollback via DELETE /rest/decided_list/<id>.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: 'Missing credential for custom list deployment' }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; listId: number | string | null; existedBefore: boolean; content: string[][] | null }> = []
  const applied: string[] = []

  try {
    const live = await listAll<SoarCustomList>(base, headers, 'decided_list')

    for (const item of items) {
      const spec = buildListSpec(item.fields)
      if (!spec.id) continue
      if (spec.error || !spec.content) {
        return {
          success: false,
          message: `Custom list ${spec.id}: ${spec.error ?? 'invalid configuration'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const existing = findListByName(live, spec.id)
      if (existing && existing.id != null) {
        let priorContent: string[][] | null = null
        try {
          priorContent = parseFormattedContent(
            await getJson<unknown>(`${base}/rest/decided_list/${encodeURIComponent(String(existing.id))}/formatted_content?_output_format=json`, headers),
          )
        } catch {
          priorContent = null // best-effort — rollback simply won't restore this one
        }
        await sendJson('POST', `${base}/rest/decided_list/${encodeURIComponent(String(existing.id))}`, headers, { content: spec.content })
        previous.push({ name: spec.id, listId: existing.id, existedBefore: true, content: priorContent })
      } else {
        const created = await sendJson<{ id?: number | string }>('POST', `${base}/rest/decided_list`, headers, {
          name: spec.id,
          content: spec.content,
        })
        previous.push({ name: spec.id, listId: created?.id ?? null, existedBefore: false, content: null })
      }
      applied.push(spec.id)
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom list(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom list deploy failed after ${applied.length} list(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
