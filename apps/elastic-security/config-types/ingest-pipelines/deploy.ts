import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, parseJson, type ElasticClient } from '../../lib/elastic'
import {
  extractPipelineSpecs,
  isManagedPipeline,
  parseJsonArray,
  parseJsonObject,
  type IngestPipelineSpec,
  type LiveIngestPipeline,
  type LiveIngestPipelineResponse,
} from './validate'

export interface IngestPipelineRollbackEntry {
  id: string
  /** True when a pipeline of this id already existed before the deploy. */
  existed: boolean
  /** The prior live pipeline, captured so an update can be restored. */
  prior?: LiveIngestPipeline
}

/**
 * Deploy Elasticsearch ingest pipelines via the _ingest API.
 *
 * Identity is the pipeline ID, carried in the path. `PUT /_ingest/pipeline/{id}`
 * is a TRUE UPSERT — the same call creates a missing pipeline and replaces an
 * existing one — so there is no separate create/update branch. For each pipeline:
 *   - GET  /_ingest/pipeline/{id}  — read prior state (404 = absent). Capture
 *                                    the prior pipeline for rollback and
 *                                    whether it existed. If the live pipeline
 *                                    carries `_meta.managed: true` it is
 *                                    Elastic/integration-MANAGED and the deploy
 *                                    FAILS (never modify those).
 *   - PUT  /_ingest/pipeline/{id}  — upsert the body { description?, processors, on_failure?, version?, _meta? }.
 *
 * Ingest pipelines are an Elasticsearch endpoint, so all requests go through
 * client.elasticsearch(), which requires the "Elasticsearch URL" app setting; if
 * it is unset the first request returns status 0 with an explanatory body, which
 * surfaces here as the deploy failure message.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, kibanaUrl } = built

  const specs = extractPipelineSpecs(ctx.canvas).filter((s) => s.id && s.processorsJson)
  const rollbackState: IngestPipelineRollbackEntry[] = []
  const createdPipelines: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const body = buildPipelineBody(spec)

      const existing = await getIngestPipeline(client, spec.id)

      if (existing && isManagedPipeline(existing)) {
        throw new Error(
          `Ingest pipeline "${spec.id}" is Elastic/integration-managed (_meta.managed = true) — refusing to modify a managed pipeline`,
        )
      }

      rollbackState.push({ id: spec.id, existed: existing !== null, prior: existing ?? undefined })
      if (existing === null) createdPipelines.push(spec.id)

      // TRUE UPSERT — one PUT both creates and replaces.
      const res = await client.elasticsearch('PUT', `/_ingest/pipeline/${encodeURIComponent(spec.id)}`, { body })
      if (!res.ok) {
        throw new Error(`Failed to upsert ingest pipeline "${spec.id}": ${elasticErrorMessage(res)}`)
      }

      deployed.push(spec.id)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ingest pipeline(s) to the Elastic deployment at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { deployment: kibanaUrl, deployedPipelines: deployed },
      rollbackData: { previousState: rollbackState, createdPipelines },
    }
  } catch (error) {
    return {
      success: false,
      message: `Ingest pipeline deployment failed after ${deployed.length} of ${specs.length} pipeline(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployment: kibanaUrl, deployedPipelines: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdPipelines },
    }
  }
}

// --- Helpers ---

/**
 * Fetch a single pipeline by id; null on 404 (absent). The response is a map
 * keyed by id — `{ "<id>": { description, processors, ... } }` — so we unwrap
 * the entry for the requested id.
 */
export async function getIngestPipeline(client: ElasticClient, id: string): Promise<LiveIngestPipeline | null> {
  const res = await client.elasticsearch('GET', `/_ingest/pipeline/${encodeURIComponent(id)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read ingest pipeline "${id}": ${elasticErrorMessage(res)}`)
  }
  const parsed = parseJson<LiveIngestPipelineResponse>(res.body)
  return parsed?.[id] ?? null
}

/** Build the upsert body from a spec. Validated upstream; re-parsed here to fail loudly rather than PUT a malformed pipeline. */
export function buildPipelineBody(spec: IngestPipelineSpec): Record<string, unknown> {
  const processors = spec.processorsJson ? parseJsonArray(spec.processorsJson) : null
  if (!processors) {
    throw new Error(`Ingest pipeline "${spec.id}": Processors is not a valid JSON array`)
  }

  const body: Record<string, unknown> = { processors }
  if (spec.description !== undefined) body.description = spec.description
  if (spec.version !== undefined) body.version = spec.version

  if (spec.onFailureJson) {
    const onFailure = parseJsonArray(spec.onFailureJson)
    if (!onFailure) throw new Error(`Ingest pipeline "${spec.id}": On Failure is not a valid JSON array`)
    body.on_failure = onFailure
  }

  if (spec.metaJson) {
    const meta = parseJsonObject(spec.metaJson)
    if (!meta) throw new Error(`Ingest pipeline "${spec.id}": Meta is not a valid JSON object`)
    body._meta = meta
  }

  return body
}
