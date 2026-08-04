import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged, sendJson } from '../../lib/sumoLogicApi'
import { buildScheduledViewCreateBody, buildScheduledViewUpdateBody, findScheduledView, type ScheduledView } from './_shared'

/**
 * Deploy Sumo Logic scheduled views over the Management API (HTTPS):
 *   read (upsert/rollback): GET  /scheduledViews            → { data: [...], next } (paged)
 *   create:                 POST /scheduledViews            with { indexName, query, startTime, retentionPeriod, ... }
 *   update:                 PUT  /scheduledViews/<id>        with only the mutable subset (id lives in the path)
 *
 * The view's INDEX NAME is the stable identity used to upsert. `query`,
 * `indexName` and `startTime` are only accepted by Sumo Logic on create — an
 * update request silently ignores them — so update() only ever sends
 * retentionPeriod / dataForwardingId / timeZone / description.
 * rollbackData records, per view, the prior update-subset body (null when it did
 * not exist) AND the view id — so rollback can restore the prior mutable state or
 * disable the one we created (scheduled views cannot be truly deleted, only
 * disabled — verified against the official API: DELETE .../disable).
 *
 * API: https://www.sumologic.com/help/docs/api/scheduled-views/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for scheduled view deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ indexName: string; viewId: string | null; priorUpdateBody: Record<string, unknown> | null }> = []
  const applied: string[] = []
  const immutableDrift: string[] = []

  let live: ScheduledView[] = []
  try {
    live = await listPaged<ScheduledView>(base, 'scheduledViews', headers)
  } catch {
    live = []
  }

  try {
    for (const item of items) {
      const indexName = String(item.fields.indexName ?? '').trim()
      if (!indexName) continue

      const existing = findScheduledView(live, indexName)

      if (existing && existing.id != null) {
        const declaredQuery = String(item.fields.query ?? '').trim()
        if (declaredQuery && existing.query && declaredQuery !== existing.query.trim()) {
          immutableDrift.push(indexName)
        }
        const priorUpdateBody = buildScheduledViewUpdateBody(
          { retentionPeriod: existing.retentionPeriod, dataForwardingId: existing.dataForwardingId, timeZone: existing.timeZone, description: existing.description },
          existing,
        )
        const body = buildScheduledViewUpdateBody(item.fields, existing)
        await sendJson('PUT', `${base}/scheduledViews/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ indexName, viewId: String(existing.id), priorUpdateBody })
      } else {
        const body = buildScheduledViewCreateBody(item.fields)
        const created = await sendJson<ScheduledView>('POST', `${base}/scheduledViews`, headers, body)
        previous.push({ indexName, viewId: created?.id != null ? String(created.id) : null, priorUpdateBody: null })
      }
      applied.push(indexName)
    }

    const driftNote = immutableDrift.length
      ? ` (note: query differs from the live view for ${immutableDrift.join(', ')} — Sumo Logic does not accept query changes on an existing scheduled view; the live query was left unchanged)`
      : ''
    return {
      success: true,
      message: `Applied ${applied.length} scheduled view(s): ${applied.join(', ') || '(none)'}${driftNote}`,
      artifacts: { applied, immutableDrift },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scheduled view deploy failed after ${applied.length} view(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
