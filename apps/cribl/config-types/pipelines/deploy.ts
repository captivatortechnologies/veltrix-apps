import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCriblUrl, criblConnect, getJson, sendJson, groupResourcePath } from '../../lib/criblApi'
import { buildPipelineBody, findPipeline, parseConf, pipelinesFromList, resolveWorkerGroup, type CriblPipeline } from './_shared'

/**
 * Deploy Cribl pipelines over the REST API:
 *   read (rollback): GET   /api/v1/m/<group>/pipelines            → find live by id
 *   create:          POST  /api/v1/m/<group>/pipelines            with { id, conf }
 *   update:          PATCH /api/v1/m/<group>/pipelines/<id>        with { id, conf }
 *
 * The pipeline id is the stable identity used to upsert. rollbackData records,
 * per pipeline, the prior pipeline object (null when it did not exist) AND its
 * group — so rollback can restore the prior config or delete the one we created.
 * Live lists are read once per worker group and reused.
 *
 * NOTE: Cribl create/update paths + list envelope follow the documented REST API
 * (/api/v1/m/<group>/pipelines). Verify against a live Cribl.
 */
async function listPipelines(base: string, headers: Record<string, string>, group: string): Promise<CriblPipeline[]> {
  try {
    return pipelinesFromList(await getJson<unknown>(groupResourcePath(base, group, 'pipelines'), headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for pipeline deployment' }
  }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)

  const previous: Array<{ id: string; group: string; pipeline: CriblPipeline | null }> = []
  const applied: string[] = []
  const liveByGroup = new Map<string, CriblPipeline[]>()

  try {
    const headers = await criblConnect(base, credential)

    for (const item of items) {
      const id = String(item.fields.id ?? '').trim()
      if (!id) continue

      const { conf, error } = parseConf(item.fields.conf)
      if (error || !conf) {
        return { success: false, message: `Pipeline ${id}: ${error ?? 'invalid conf'}`, artifacts: { applied }, rollbackData: { previous } }
      }

      const group = resolveWorkerGroup(item.fields, settings ?? {})
      if (!liveByGroup.has(group)) liveByGroup.set(group, await listPipelines(base, headers, group))
      const live = liveByGroup.get(group)!

      const existing = findPipeline(live, id)
      const body = buildPipelineBody(id, conf)

      if (existing) {
        await sendJson('PATCH', `${groupResourcePath(base, group, 'pipelines')}/${encodeURIComponent(id)}`, headers, body)
        previous.push({ id, group, pipeline: existing })
      } else {
        await sendJson('POST', groupResourcePath(base, group, 'pipelines'), headers, body)
        previous.push({ id, group, pipeline: null })
      }
      applied.push(group ? `${group}/${id}` : id)
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
