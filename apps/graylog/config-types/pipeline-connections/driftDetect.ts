import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { resolveStreamId, resolvePipelineIds, parsePipelineTitles, type GraylogPipelineConnections } from './_shared'

/**
 * Drift for pipeline connections: compare the declared pipeline id set (resolved
 * from titles) against the live connected set for each stream. Order-insensitive
 * (Graylog's `pipeline_ids` is an unordered Set). Best-effort — a stream or
 * pipeline title that can't be resolved is skipped rather than raising false
 * drift. Read-only: GET /api/system/pipelines/connections/{streamId}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const item of items) {
    const streamTitle = asString(item.fields.stream_title)
    if (!streamTitle) continue

    const streamId = await resolveStreamId(base, headers, streamTitle)
    if (!streamId) continue

    const { titles, error } = parsePipelineTitles(item.fields.pipeline_titles)
    if (error) continue
    const { ids: expectedIds } = await resolvePipelineIds(base, headers, titles)

    let live: GraylogPipelineConnections | null = null
    try {
      live = await getJson<GraylogPipelineConnections>(`${base}/api/system/pipelines/connections/${encodeURIComponent(streamId)}`, headers)
    } catch {
      live = null
    }
    const actualIds = live?.pipeline_ids ?? []

    const expectedSorted = [...expectedIds].sort().join(',')
    const actualSorted = [...actualIds].sort().join(',')
    if (expectedSorted !== actualSorted) {
      diffs.push({
        field: `${streamTitle}.pipeline_ids`,
        expected: expectedSorted || '(none)',
        actual: actualSorted || '(none)',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
