import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import { buildCreateBody, buildUpdateBody, extractLogMetricSpecs, parseJsonArray, toCreatePayload, toUpdatePayload, type LogMetricResource } from './_shared'

/**
 * Deploy Log-Based Metrics via GET/POST/PATCH/DELETE
 * /api/v2/logs/config/metrics[/{metric_id}]:
 *   https://docs.datadoghq.com/api/latest/logs-metrics/create-a-log-based-metric/
 *   https://docs.datadoghq.com/api/latest/logs-metrics/update-a-log-based-metric/
 *
 * Identity is the metric's OWN `id` (its name) — chosen once and permanent,
 * so this is a DIRECT lookup (GET .../{id}; 404 means absent) rather than the
 * list+match-by-name pattern used by every other config type in this app.
 *   - existing: UPDATED (PATCH) with only the mutable fields (filter,
 *     group_by, compute.include_percentiles) — aggregation_type/path are
 *     create-only and are never sent on update.
 *   - absent: CREATED (POST) with the full body.
 */
export interface LogMetricRollbackEntry {
  id: string
  existed: boolean
  prior?: LogMetricResource
}

const METRICS_PATH = '/api/v2/logs/config/metrics'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractLogMetricSpecs(ctx.canvas).filter((s) => s.id)
  const rollbackState: LogMetricRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.id

      const groupBy = parseJsonArray(spec.groupByRaw)
      if (!groupBy.ok) {
        throw new Error(`Metric "${label}": group_by must be valid JSON — validate this configuration before deploying`)
      }

      const existing = await getLogMetric(client, spec.id)

      if (existing) {
        rollbackState.push({ id: spec.id, existed: true, prior: existing })
        const body = buildUpdateBody(spec, groupBy.value ?? [])
        const res = await client.request('PATCH', `${METRICS_PATH}/${encodeURIComponent(spec.id)}`, { body: toUpdatePayload(body) })
        if (!res.ok) throw new Error(`Failed to update metric "${label}": ${datadogErrorMessage(res)}`)
      } else {
        rollbackState.push({ id: spec.id, existed: false })
        const body = buildCreateBody(spec, groupBy.value ?? [])
        const res = await client.request('POST', METRICS_PATH, { body: toCreatePayload(spec.id, body) })
        if (!res.ok) throw new Error(`Failed to create metric "${label}": ${datadogErrorMessage(res)}`)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Log-Based Metric(s) to ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedMetrics: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Log-based metric deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedMetrics: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / driftDetect) --------------

/** Direct lookup by id. Returns null on 404 (absent); throws on any other error. */
export async function getLogMetric(client: DatadogClient, id: string): Promise<LogMetricResource | null> {
  const res = await client.request('GET', `${METRICS_PATH}/${encodeURIComponent(id)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to read metric "${id}": ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ data?: LogMetricResource }>(res.body)
  return parsed?.data ?? null
}

/** List every Log-Based Metric (used by healthCheck / driftDetect for a cheap reachability probe). */
export async function listLogMetrics(client: DatadogClient): Promise<LogMetricResource[]> {
  const res = await client.request('GET', METRICS_PATH)
  if (!res.ok) throw new Error(`Failed to list Log-Based Metrics: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ data?: LogMetricResource[] }>(res.body)
  return Array.isArray(parsed?.data) ? (parsed?.data as LogMetricResource[]) : []
}
