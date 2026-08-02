import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildIndexSetBody, indexSetsFromList, findIndexSet, type GraylogIndexSet } from './_shared'

/**
 * Deploy Graylog index sets over the REST API:
 *   read (rollback): GET  /api/system/indices/index_sets       → find by title
 *   create:          POST /api/system/indices/index_sets        → IndexSetSummary { id, ... }
 *   update:          PUT  /api/system/indices/index_sets/{id}   → IndexSetSummary
 *
 * The index-set TITLE is the stable identity used to upsert. rollbackData records,
 * per index set, the prior summary (null when it did not exist) AND the id — so
 * rollback can restore the prior config or delete the one we created.
 */
interface IndexSetCreateResponse {
  id?: string
}

async function listIndexSets(base: string, headers: Record<string, string>): Promise<GraylogIndexSet[]> {
  try {
    return indexSetsFromList(await getJson<unknown>(`${base}/api/system/indices/index_sets`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for index-set deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ title: string; indexSetId: string | null; indexSet: GraylogIndexSet | null }> = []
  const applied: string[] = []

  try {
    const live = await listIndexSets(base, headers)

    for (const item of items) {
      const title = asString(item.fields.title)
      if (!title) continue

      const { body, error } = buildIndexSetBody(item.fields)
      if (error || !body) throw new Error(`Index set "${title}": ${error ?? 'could not build request body'}`)

      const existing = findIndexSet(live, title)
      if (existing && existing.id) {
        await sendJson('PUT', `${base}/api/system/indices/index_sets/${encodeURIComponent(existing.id)}`, headers, { ...body, id: existing.id })
        previous.push({ title, indexSetId: existing.id, indexSet: existing })
      } else {
        const created = await sendJson<IndexSetCreateResponse>('POST', `${base}/api/system/indices/index_sets`, headers, body)
        previous.push({ title, indexSetId: created?.id ?? null, indexSet: null })
      }
      applied.push(title)
    }

    return {
      success: true,
      message: `Applied ${applied.length} index set(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Index-set deploy failed after ${applied.length} index set(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
