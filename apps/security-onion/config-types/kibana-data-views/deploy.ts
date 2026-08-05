import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSocUrl, buildAuthHeader, soRequest, getJson, sendJson } from '../../lib/soConsole'
import { buildDataViewFields, type DataViewGetResponse } from './_shared'

/**
 * Deploy Kibana data views (index patterns) over the SOC console REST API
 * (443) — Kibana's own Data Views API, the same non-SO-specific Kibana REST
 * surface `detections` already uses for the Detection Engine:
 *   read (rollback): GET  /api/data_views/data_view/<id>     (best-effort — 404 = new)
 *   create:          POST /api/data_views/data_view           { data_view: { id, ... } }
 *   update:          POST /api/data_views/data_view/<id>      { data_view: { ...partial } }
 * https://www.elastic.co/guide/en/kibana/current/data-views-api-create.html
 * https://www.elastic.co/guide/en/kibana/current/data-views-api-update.html
 *
 * rollbackData records the prior data_view fields per id (null when it did
 * not exist) so rollback can restore them or DELETE the one we created.
 */

/** Read the live data view (best-effort) for the rollback snapshot; null on any miss. */
async function readDataView(base: string, headers: Record<string, string>, id: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await getJson<DataViewGetResponse>(`${base}/api/data_views/data_view/${encodeURIComponent(id)}`, headers)
    return res.data_view ?? null
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for data view deployment' }
  }

  const base = buildSocUrl(component, connectivity, connectivityProvider)
  const headers = { ...buildAuthHeader(credential), 'kbn-xsrf': 'true' }

  const previous: Array<{ dataViewId: string; dataView: Record<string, unknown> | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const dataViewId = String(item.fields.dataViewId ?? '').trim()
      if (!dataViewId) continue

      const existing = await readDataView(base, headers, dataViewId)
      previous.push({ dataViewId, dataView: existing })

      const data_view = buildDataViewFields(item.fields)
      if (existing) {
        await sendJson('POST', `${base}/api/data_views/data_view/${encodeURIComponent(dataViewId)}`, headers, { data_view })
      } else {
        const res = await soRequest(`${base}/api/data_views/data_view`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ data_view: { id: dataViewId, ...data_view } }),
        })
        if (!res.ok) throw new Error(`POST ${base}/api/data_views/data_view → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
      }
      applied.push(dataViewId)
    }

    return {
      success: true,
      message: `Applied ${applied.length} data view(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Data view deploy failed after ${applied.length} view(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
