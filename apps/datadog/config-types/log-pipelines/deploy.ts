import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import { buildPipelineBody, extractPipelineSpecs, isReadOnlyPipeline, parseJsonArray, pipelineKey, type LogPipeline } from './_shared'

/**
 * Deploy Datadog Log Pipelines via
 * GET/POST/PUT/DELETE /api/v1/logs/config/pipelines[/{pipeline_id}]:
 *   https://docs.datadoghq.com/api/latest/logs-pipelines/create-a-pipeline/
 *   https://docs.datadoghq.com/api/latest/logs-pipelines/get-a-pipeline/
 *   https://docs.datadoghq.com/api/latest/logs-pipelines/update-a-pipeline/
 *
 * Identity is the pipeline NAME (case-insensitive). The tenant's live
 * pipelines are listed, matched by name, and:
 *   - a match is UPDATED (PUT, full-replace) — its full prior state is
 *     captured for rollback FIRST.
 *   - PROTECTED: a matched pipeline that is `is_read_only` (a Datadog-managed
 *     INTEGRATION pipeline, e.g. the built-in "nginx" pipeline) is NEVER
 *     modified — the whole deploy fails loudly rather than silently skip or
 *     overwrite it, exactly like this app's log_detection Security Monitoring
 *     Rules handle name collisions with built-ins by failing fast on
 *     unexpected server responses. Pick a different pipeline name.
 *   - no match is CREATED (POST); the id is recorded so rollback can delete
 *     it.
 *
 * This does NOT touch pipeline ORDER (a separate singleton resource — see the
 * header comment in _shared.ts).
 */
export interface PipelineRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LogPipeline
}

const PIPELINES_PATH = '/api/v1/logs/config/pipelines'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPipelineSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: PipelineRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listPipelines(client)
    const byKey = new Map(existing.filter((p) => p.name).map((p) => [pipelineKey(p.name as string), p]))

    for (const spec of specs) {
      const label = spec.name
      const key = pipelineKey(spec.name)

      const processors = parseJsonArray(spec.processorsRaw)
      if (!processors.ok) {
        throw new Error(`Pipeline "${label}": processors must be valid JSON — validate this configuration before deploying`)
      }

      const live = byKey.get(key)

      if (live && live.id) {
        if (isReadOnlyPipeline(live)) {
          throw new Error(
            `Pipeline "${label}" matches a Datadog-managed INTEGRATION pipeline (is_read_only). ` +
              'Integration pipelines are Datadog-managed and must not be modified — choose a different pipeline name.',
          )
        }
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })

        const body = buildPipelineBody(spec, processors.value ?? [])
        const res = await client.request('PUT', `${PIPELINES_PATH}/${encodeURIComponent(live.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to update pipeline "${label}": ${datadogErrorMessage(res)}`)
      } else {
        const body = buildPipelineBody(spec, processors.value ?? [])
        const res = await client.request('POST', PIPELINES_PATH, { body })
        if (!res.ok) throw new Error(`Failed to create pipeline "${label}": ${datadogErrorMessage(res)}`)
        const created = parseJson<LogPipeline>(res.body)
        const id = created?.id
        if (!id) throw new Error(`Pipeline "${label}" was created but Datadog returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Log Pipeline(s) to ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPipelines: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Log Pipeline deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPipelines: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / driftDetect) --------------

/**
 * List every Log Pipeline. UNVERIFIED response envelope (flagged in
 * _shared.ts's header comment — the dedicated doc page 404'd): modeled as a
 * plain JSON array (the v1 API's convention elsewhere), with a defensive
 * unwrap for a {"pipelines":[...]} or {"data":[...]} wrapper.
 */
export async function listPipelines(client: DatadogClient): Promise<LogPipeline[]> {
  const res = await client.request('GET', PIPELINES_PATH)
  if (!res.ok) throw new Error(`Failed to list Log Pipelines: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<LogPipeline[] | { pipelines?: LogPipeline[]; data?: LogPipeline[] }>(res.body)
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed?.pipelines)) return parsed.pipelines
  if (Array.isArray(parsed?.data)) return parsed.data
  return []
}

/** Read one pipeline's full, authoritative state. Throws on error. */
export async function readPipeline(client: DatadogClient, id: string): Promise<LogPipeline> {
  const res = await client.request('GET', `${PIPELINES_PATH}/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`Failed to read pipeline ${id}: ${datadogErrorMessage(res)}`)
  const pipeline = parseJson<LogPipeline>(res.body)
  if (!pipeline) throw new Error(`Pipeline ${id} was not found`)
  return pipeline
}
