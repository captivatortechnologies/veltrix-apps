import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, parseJson, type ElasticClient } from '../../lib/elastic'
import {
  extractJobSpecs,
  parseJsonObject,
  type LiveMlDatafeed,
  type LiveMlDatafeedListResponse,
  type LiveMlDatafeedStatsResponse,
  type LiveMlJob,
  type LiveMlJobListResponse,
  type LiveMlJobStatsResponse,
  type MlDatafeedState,
  type MlJobSpec,
  type MlJobState,
} from './validate'

export interface MlJobRollbackEntry {
  jobId: string
  datafeedId: string
  jobExisted: boolean
  datafeedExisted: boolean
  priorJob?: LiveMlJob
  priorDatafeed?: LiveMlDatafeed
  /** Whether the job was opened (and its datafeed started) before this deploy. */
  wasRunning: boolean
}

/**
 * Deploy an Elasticsearch ML anomaly detection job + its datafeed via the
 * _ml API.
 *
 * `analysis_config` and `data_description` are IMMUTABLE after job creation —
 * the job _update endpoint does not accept them — so they are sent ONLY on
 * create; an update sends the mutable subset (description, groups,
 * analysis_limits, model_plot_config, + the advanced catch-all). The datafeed
 * has no verified immutable subset, so its full body is sent on both create
 * and update. For each job:
 *   - GET  /_ml/anomaly_detectors/{jobId}       — read prior (404 = absent)
 *   - PUT  /_ml/anomaly_detectors/{jobId}       — create when absent (full job body)
 *   - POST /_ml/anomaly_detectors/{jobId}/_update — update when present (mutable subset)
 *   - GET  /_ml/datafeeds/{datafeedId}          — read prior (404 = absent)
 *   - PUT  /_ml/datafeeds/{datafeedId}          — create when absent
 *   - POST /_ml/datafeeds/{datafeedId}/_update  — update when present (full body)
 *   - converge: Enabled -> open job + start datafeed; disabled -> stop datafeed + close job
 *
 * ML jobs are an Elasticsearch endpoint, so all requests go through
 * client.elasticsearch(), which requires the "Elasticsearch URL" app setting,
 * and require an ML-enabled subscription/trial.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, kibanaUrl } = built

  const specs = extractJobSpecs(ctx.canvas).filter((s) => s.jobId && s.analysisConfigJson && s.dataDescriptionJson)
  const rollbackState: MlJobRollbackEntry[] = []
  const createdJobs: string[] = []
  const createdDatafeeds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.jobId

      const analysisConfig = parseJsonObject(spec.analysisConfigJson as string)
      const dataDescription = parseJsonObject(spec.dataDescriptionJson as string)
      if (!analysisConfig) throw new Error(`ML job "${label}": Analysis Config is not a valid JSON object`)
      if (!dataDescription) throw new Error(`ML job "${label}": Data Description is not a valid JSON object`)

      const existingJob = await getJob(client, spec.jobId)
      const existingDatafeed = await getDatafeed(client, spec.datafeedId)
      const wasRunning = existingJob ? (await getJobState(client, spec.jobId)) === 'opened' : false

      if (!existingJob) {
        const res = await client.elasticsearch('PUT', `/_ml/anomaly_detectors/${encodeURIComponent(spec.jobId)}`, {
          body: buildJobCreateBody(spec, analysisConfig, dataDescription),
        })
        if (!res.ok) throw new Error(`Failed to create ML job "${label}": ${elasticErrorMessage(res)}`)
        createdJobs.push(spec.jobId)
      } else {
        const res = await client.elasticsearch(
          'POST',
          `/_ml/anomaly_detectors/${encodeURIComponent(spec.jobId)}/_update`,
          { body: buildJobUpdateBody(spec) },
        )
        if (!res.ok) throw new Error(`Failed to update ML job "${label}": ${elasticErrorMessage(res)}`)
      }

      if (!existingDatafeed) {
        const res = await client.elasticsearch('PUT', `/_ml/datafeeds/${encodeURIComponent(spec.datafeedId)}`, {
          body: buildDatafeedBody(spec, true),
        })
        if (!res.ok) throw new Error(`Failed to create datafeed "${spec.datafeedId}": ${elasticErrorMessage(res)}`)
        createdDatafeeds.push(spec.datafeedId)
      } else {
        const res = await client.elasticsearch('POST', `/_ml/datafeeds/${encodeURIComponent(spec.datafeedId)}/_update`, {
          body: buildDatafeedBody(spec, false),
        })
        if (!res.ok) throw new Error(`Failed to update datafeed "${spec.datafeedId}": ${elasticErrorMessage(res)}`)
      }

      rollbackState.push({
        jobId: spec.jobId,
        datafeedId: spec.datafeedId,
        jobExisted: existingJob !== null,
        datafeedExisted: existingDatafeed !== null,
        priorJob: existingJob ?? undefined,
        priorDatafeed: existingDatafeed ?? undefined,
        wasRunning,
      })

      await converge(client, spec.jobId, spec.datafeedId, spec.enabled)
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ML job(s) to the Elastic deployment at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { deployment: kibanaUrl, deployedJobs: deployed },
      rollbackData: { previousState: rollbackState, createdJobs, createdDatafeeds },
    }
  } catch (error) {
    return {
      success: false,
      message: `ML job deployment failed after ${deployed.length} of ${specs.length} job(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployment: kibanaUrl, deployedJobs: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdJobs, createdDatafeeds },
    }
  }
}

// --- Helpers ---

export async function getJob(client: ElasticClient, jobId: string): Promise<LiveMlJob | null> {
  const res = await client.elasticsearch('GET', `/_ml/anomaly_detectors/${encodeURIComponent(jobId)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to read ML job "${jobId}": ${elasticErrorMessage(res)}`)
  return parseJson<LiveMlJobListResponse>(res.body)?.jobs?.[0] ?? null
}

export async function getJobState(client: ElasticClient, jobId: string): Promise<MlJobState> {
  const res = await client.elasticsearch('GET', `/_ml/anomaly_detectors/${encodeURIComponent(jobId)}/_stats`)
  if (!res.ok) return 'closed'
  return parseJson<LiveMlJobStatsResponse>(res.body)?.jobs?.[0]?.state ?? 'closed'
}

export async function getDatafeed(client: ElasticClient, datafeedId: string): Promise<LiveMlDatafeed | null> {
  const res = await client.elasticsearch('GET', `/_ml/datafeeds/${encodeURIComponent(datafeedId)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to read datafeed "${datafeedId}": ${elasticErrorMessage(res)}`)
  return parseJson<LiveMlDatafeedListResponse>(res.body)?.datafeeds?.[0] ?? null
}

export async function getDatafeedState(client: ElasticClient, datafeedId: string): Promise<MlDatafeedState> {
  const res = await client.elasticsearch('GET', `/_ml/datafeeds/${encodeURIComponent(datafeedId)}/_stats`)
  if (!res.ok) return 'stopped'
  return parseJson<LiveMlDatafeedStatsResponse>(res.body)?.datafeeds?.[0]?.state ?? 'stopped'
}

/**
 * Converge running state to the "enabled" flag. Enabling opens the job (a
 * datafeed can only start once its job is open) then starts the datafeed;
 * disabling stops the datafeed first (a job cannot close while its datafeed is
 * running) then closes the job. Idempotent — already-converged jobs are left
 * alone.
 */
export async function converge(client: ElasticClient, jobId: string, datafeedId: string, enabled: boolean): Promise<void> {
  if (enabled) {
    const jobState = await getJobState(client, jobId)
    if (jobState !== 'opened' && jobState !== 'opening') {
      const res = await client.elasticsearch('POST', `/_ml/anomaly_detectors/${encodeURIComponent(jobId)}/_open`)
      if (!res.ok) throw new Error(`Failed to open ML job "${jobId}": ${elasticErrorMessage(res)}`)
    }
    const dfState = await getDatafeedState(client, datafeedId)
    if (dfState !== 'started' && dfState !== 'starting') {
      const res = await client.elasticsearch('POST', `/_ml/datafeeds/${encodeURIComponent(datafeedId)}/_start`)
      if (!res.ok) throw new Error(`Failed to start datafeed "${datafeedId}": ${elasticErrorMessage(res)}`)
    }
  } else {
    const dfState = await getDatafeedState(client, datafeedId)
    if (dfState === 'started' || dfState === 'starting') {
      const res = await client.elasticsearch('POST', `/_ml/datafeeds/${encodeURIComponent(datafeedId)}/_stop`, {
        query: { force: true },
      })
      if (!res.ok) throw new Error(`Failed to stop datafeed "${datafeedId}": ${elasticErrorMessage(res)}`)
    }
    const jobState = await getJobState(client, jobId)
    if (jobState === 'opened' || jobState === 'opening') {
      const res = await client.elasticsearch('POST', `/_ml/anomaly_detectors/${encodeURIComponent(jobId)}/_close`, {
        query: { force: true },
      })
      if (!res.ok) throw new Error(`Failed to close ML job "${jobId}": ${elasticErrorMessage(res)}`)
    }
  }
}

/** Build the job CREATE body — the only time analysis_config/data_description/results_index_name are sent. */
export function buildJobCreateBody(
  spec: MlJobSpec,
  analysisConfig: Record<string, unknown>,
  dataDescription: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    analysis_config: analysisConfig,
    data_description: dataDescription,
    ...mutableJobFields(spec),
  }
  if (spec.resultsIndexName) body.results_index_name = spec.resultsIndexName
  return body
}

/** Build the job _update body — analysis_config/data_description/results_index_name are intentionally omitted (immutable). */
export function buildJobUpdateBody(spec: MlJobSpec): Record<string, unknown> {
  return mutableJobFields(spec)
}

function mutableJobFields(spec: MlJobSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { groups: spec.groups }
  if (spec.description !== undefined) body.description = spec.description

  if (spec.analysisLimitsJson) {
    const limits = parseJsonObject(spec.analysisLimitsJson)
    if (!limits) throw new Error(`ML job "${spec.jobId}": Analysis Limits is not a valid JSON object`)
    body.analysis_limits = limits
  }
  if (spec.modelPlotConfigJson) {
    const modelPlot = parseJsonObject(spec.modelPlotConfigJson)
    if (!modelPlot) throw new Error(`ML job "${spec.jobId}": Model Plot Config is not a valid JSON object`)
    body.model_plot_config = modelPlot
  }
  if (spec.jobAdvancedJson) {
    const advanced = parseJsonObject(spec.jobAdvancedJson)
    if (!advanced) throw new Error(`ML job "${spec.jobId}": Advanced Job Settings is not a valid JSON object`)
    Object.assign(body, advanced)
  }
  return body
}

/** Build the datafeed body — sent in full on both create (forCreate adds job_id) and update. */
export function buildDatafeedBody(spec: MlJobSpec, forCreate: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { indices: spec.datafeedIndices }
  if (forCreate) body.job_id = spec.jobId

  if (spec.datafeedQueryJson) {
    const query = parseJsonObject(spec.datafeedQueryJson)
    if (!query) throw new Error(`ML job "${spec.jobId}": Datafeed Query is not a valid JSON object`)
    body.query = query
  }
  if (spec.datafeedAdvancedJson) {
    const advanced = parseJsonObject(spec.datafeedAdvancedJson)
    if (!advanced) throw new Error(`ML job "${spec.jobId}": Advanced Datafeed Settings is not a valid JSON object`)
    Object.assign(body, advanced)
  }
  return body
}
