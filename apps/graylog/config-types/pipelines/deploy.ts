import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildPipelineBody, pipelinesFromList, findPipeline, type GraylogPipeline } from './_shared'

/**
 * Deploy Graylog processing pipelines over the REST API:
 *   read (rollback): GET  /api/system/pipelines/pipeline       → find the live pipeline by title
 *   create:          POST /api/system/pipelines/pipeline        → PipelineSource { id, title, ... }
 *   update:          PUT  /api/system/pipelines/pipeline/{id}   → PipelineSource
 *
 * The pipeline TITLE (= the DSL pipeline name, enforced by validate) is the
 * stable identity used to upsert. rollbackData records, per pipeline, the prior
 * pipeline (null when it did not exist) AND the pipeline id — so rollback can
 * restore the prior source or delete the one we created.
 */
interface PipelineCreateResponse {
  id?: string
}

async function listPipelines(base: string, headers: Record<string, string>): Promise<GraylogPipeline[]> {
  try {
    return pipelinesFromList(await getJson<unknown>(`${base}/api/system/pipelines/pipeline`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for pipeline deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ title: string; pipelineId: string | null; pipeline: GraylogPipeline | null }> = []
  const applied: string[] = []

  try {
    const live = await listPipelines(base, headers)

    for (const item of items) {
      const title = asString(item.fields.title)
      if (!title) continue

      const body = buildPipelineBody(item.fields)
      const existing = findPipeline(live, title)

      if (existing && existing.id) {
        await sendJson('PUT', `${base}/api/system/pipelines/pipeline/${encodeURIComponent(existing.id)}`, headers, body)
        previous.push({ title, pipelineId: existing.id, pipeline: existing })
      } else {
        const created = await sendJson<PipelineCreateResponse>('POST', `${base}/api/system/pipelines/pipeline`, headers, body)
        previous.push({ title, pipelineId: created?.id ?? null, pipeline: null })
      }
      applied.push(title)
    }

    return {
      success: true,
      message: `Applied ${applied.length} pipeline(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Pipeline deploy failed after ${applied.length} pipeline(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
