import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { converge } from './deploy'
import type { LiveMlDatafeed, LiveMlJob } from './validate'
import type { MlJobRollbackEntry } from './deploy'

/**
 * Roll back ML jobs using the state captured during deploy:
 *   - a job/datafeed pair this deploy CREATED is stopped/closed then deleted
 *     (datafeed first — it references the job); a 404 means it is already gone.
 *   - a job/datafeed pair that was UPDATED has its mutable fields restored,
 *     then its running state (opened+started / closed+stopped) is converged
 *     back to what it was before this deploy.
 *
 * The job's analysis_config / data_description are never restored — they are
 * immutable and were never changed by deploy's own update path.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: MlJobRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const { jobId, datafeedId } = entry

      // Always converge to stopped/closed before any delete so Elasticsearch
      // never refuses (a datafeed cannot be deleted while started; a job
      // cannot be deleted while its datafeed references an open state).
      await converge(client, jobId, datafeedId, false)

      if (!entry.datafeedExisted) {
        const res = await client.elasticsearch('DELETE', `/_ml/datafeeds/${encodeURIComponent(datafeedId)}`, {
          query: { force: true },
        })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete datafeed "${datafeedId}": ${elasticErrorMessage(res)}`)
        }
      } else if (entry.priorDatafeed) {
        const res = await client.elasticsearch('POST', `/_ml/datafeeds/${encodeURIComponent(datafeedId)}/_update`, {
          body: buildDatafeedRestoreBody(entry.priorDatafeed),
        })
        if (!res.ok) throw new Error(`Failed to restore datafeed "${datafeedId}": ${elasticErrorMessage(res)}`)
      }

      if (!entry.jobExisted) {
        const res = await client.elasticsearch('DELETE', `/_ml/anomaly_detectors/${encodeURIComponent(jobId)}`, {
          query: { force: true },
        })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete ML job "${jobId}": ${elasticErrorMessage(res)}`)
        }
      } else if (entry.priorJob) {
        const res = await client.elasticsearch('POST', `/_ml/anomaly_detectors/${encodeURIComponent(jobId)}/_update`, {
          body: buildJobRestoreBody(entry.priorJob),
        })
        if (!res.ok) throw new Error(`Failed to restore ML job "${jobId}": ${elasticErrorMessage(res)}`)
      }

      if (entry.jobExisted || entry.datafeedExisted) {
        await converge(client, jobId, datafeedId, entry.wasRunning)
      }

      reverted.push(jobId)
    }

    return { success: true, message: `Rolled back ${reverted.length} ML job(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} job(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild the job _update body from a captured prior job — the mutable subset only. */
function buildJobRestoreBody(prior: LiveMlJob): Record<string, unknown> {
  const body: Record<string, unknown> = { groups: prior.groups ?? [] }
  if (prior.description !== undefined) body.description = prior.description
  if (prior.analysis_limits !== undefined) body.analysis_limits = prior.analysis_limits
  if (prior.model_plot_config !== undefined) body.model_plot_config = prior.model_plot_config
  if (prior.custom_settings !== undefined) body.custom_settings = prior.custom_settings
  if (prior.categorization_filters !== undefined) body.categorization_filters = prior.categorization_filters
  if (prior.renormalization_window_days !== undefined) body.renormalization_window_days = prior.renormalization_window_days
  if (prior.results_retention_days !== undefined) body.results_retention_days = prior.results_retention_days
  if (prior.model_snapshot_retention_days !== undefined) body.model_snapshot_retention_days = prior.model_snapshot_retention_days
  if (prior.background_persist_interval !== undefined) body.background_persist_interval = prior.background_persist_interval
  if (prior.allow_lazy_open !== undefined) body.allow_lazy_open = prior.allow_lazy_open
  return body
}

/** Rebuild the datafeed _update body from a captured prior datafeed, restoring it verbatim. */
function buildDatafeedRestoreBody(prior: LiveMlDatafeed): Record<string, unknown> {
  const body: Record<string, unknown> = { indices: prior.indices ?? [] }
  if (prior.query !== undefined) body.query = prior.query
  if (prior.frequency !== undefined) body.frequency = prior.frequency
  if (prior.scroll_size !== undefined) body.scroll_size = prior.scroll_size
  if (prior.aggregations !== undefined) body.aggregations = prior.aggregations
  if (prior.runtime_mappings !== undefined) body.runtime_mappings = prior.runtime_mappings
  if (prior.chunking_config !== undefined) body.chunking_config = prior.chunking_config
  return body
}
