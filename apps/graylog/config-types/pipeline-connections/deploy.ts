import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import {
  resolveStreamId,
  resolvePipelineIds,
  parsePipelineTitles,
  type GraylogPipelineConnections,
} from './_shared'

/**
 * Deploy Graylog pipeline↔stream connections over the REST API:
 *   read (rollback): GET  /api/system/pipelines/connections/{streamId} → prior set (404 = none)
 *   replace:         POST /api/system/pipelines/connections/to_stream  → { stream_id, pipeline_ids }
 *
 * Graylog has no per-pipeline "connect"/"disconnect" call — `to_stream` REPLACES
 * the WHOLE set of pipelines wired to a stream, so this always sends the
 * complete declared list. `stream_title` and `pipeline_titles` are resolved to
 * ids first; an unresolvable stream or pipeline title fails the deploy loudly
 * rather than silently connecting a smaller set than declared.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for pipeline-connection deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ streamTitle: string; streamId: string; connections: GraylogPipelineConnections | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const streamTitle = asString(item.fields.stream_title)
      if (!streamTitle) continue

      const streamId = await resolveStreamId(base, headers, streamTitle)
      if (!streamId) throw new Error(`Stream "${streamTitle}" was not found — cannot connect pipelines to it.`)

      const { titles, error } = parsePipelineTitles(item.fields.pipeline_titles)
      if (error) throw new Error(`Stream "${streamTitle}": ${error}`)

      const { ids: pipelineIds, missing } = await resolvePipelineIds(base, headers, titles)
      if (missing.length > 0) {
        throw new Error(`Stream "${streamTitle}": pipeline(s) not found: ${missing.join(', ')}`)
      }

      // Snapshot the prior connection set (404 = none yet) before replacing it.
      let priorConnections: GraylogPipelineConnections | null = null
      try {
        priorConnections = await getJson<GraylogPipelineConnections>(
          `${base}/api/system/pipelines/connections/${encodeURIComponent(streamId)}`,
          headers,
        )
      } catch {
        priorConnections = null
      }
      previous.push({ streamTitle, streamId, connections: priorConnections })

      await sendJson('POST', `${base}/api/system/pipelines/connections/to_stream`, headers, {
        stream_id: streamId,
        pipeline_ids: pipelineIds,
      })
      applied.push(streamTitle)
    }

    return {
      success: true,
      message: `Applied pipeline connections for ${applied.length} stream(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Pipeline-connection deploy failed after ${applied.length} stream(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
