import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, parseJson, type ElasticClient } from '../../lib/elastic'
import {
  extractTransformSpecs,
  parseJsonObject,
  pickMutableKeys,
  type LiveTransform,
  type LiveTransformListResponse,
  type LiveTransformStatsResponse,
  type TransformSpec,
  type TransformState,
} from './validate'

export interface TransformRollbackEntry {
  transformId: string
  /** True when a transform of this id already existed before the deploy. */
  existed: boolean
  /** The prior live transform config, captured so an update can be restored. */
  prior?: LiveTransform
  /** Whether the transform was running (started/indexing) before this deploy. */
  wasRunning: boolean
}

/**
 * Deploy Elasticsearch transforms via the _transform API.
 *
 * Identity is the transform ID, carried in the path. UNLIKE ILM/role-mappings,
 * `PUT /_transform/{id}` is CREATE-ONLY (it errors if the id already exists) —
 * updating an existing transform goes through `POST /_transform/{id}/_update`
 * instead, and that endpoint does NOT accept the pivot/latest aggregation
 * (immutable after creation; see MUTABLE_DEFINITION_KEYS). For each transform:
 *   - GET  /_transform/{id}          — read prior config (404 = absent).
 *   - PUT  /_transform/{id}          — create when absent (full body incl. pivot/latest).
 *   - POST /_transform/{id}/_update  — update when present (mutable subset only:
 *                                       description, dest, frequency, source,
 *                                       settings, retention_policy).
 *   - GET  /_transform/{id}/_stats + POST _start / _stop — converge the running
 *     state to the "Enabled" toggle (a transform is created STOPPED).
 *
 * Transforms are an Elasticsearch endpoint, so all requests go through
 * client.elasticsearch(), which requires the "Elasticsearch URL" app setting.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, kibanaUrl } = built

  const specs = extractTransformSpecs(ctx.canvas).filter((s) => s.transformId && s.definitionJson)
  const rollbackState: TransformRollbackEntry[] = []
  const createdTransforms: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.transformId
      const definition = spec.definitionJson ? parseJsonObject(spec.definitionJson) : null
      if (!definition) {
        throw new Error(`Transform "${label}": Definition is not a valid JSON object`)
      }

      const existing = await getTransform(client, spec.transformId)
      const wasRunning = existing ? (await getTransformState(client, spec.transformId)) !== 'stopped' : false

      if (!existing) {
        const res = await client.elasticsearch('PUT', `/_transform/${encodeURIComponent(spec.transformId)}`, {
          body: buildCreateBody(spec, definition),
        })
        if (!res.ok) {
          throw new Error(`Failed to create transform "${label}": ${elasticErrorMessage(res)}`)
        }
        rollbackState.push({ transformId: spec.transformId, existed: false, wasRunning: false })
        createdTransforms.push(spec.transformId)
      } else {
        rollbackState.push({ transformId: spec.transformId, existed: true, prior: existing, wasRunning })

        const res = await client.elasticsearch(
          'POST',
          `/_transform/${encodeURIComponent(spec.transformId)}/_update`,
          { body: buildUpdateBody(spec, definition) },
        )
        if (!res.ok) {
          throw new Error(`Failed to update transform "${label}": ${elasticErrorMessage(res)}`)
        }
      }

      await converge(client, spec.transformId, spec.enabled)
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} transform(s) to the Elastic deployment at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { deployment: kibanaUrl, deployedTransforms: deployed },
      rollbackData: { previousState: rollbackState, createdTransforms },
    }
  } catch (error) {
    return {
      success: false,
      message: `Transform deployment failed after ${deployed.length} of ${specs.length} transform(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployment: kibanaUrl, deployedTransforms: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdTransforms },
    }
  }
}

// --- Helpers ---

/** Fetch a single transform's config by id; null on 404 (absent). */
export async function getTransform(client: ElasticClient, id: string): Promise<LiveTransform | null> {
  const res = await client.elasticsearch('GET', `/_transform/${encodeURIComponent(id)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read transform "${id}": ${elasticErrorMessage(res)}`)
  }
  return parseJson<LiveTransformListResponse>(res.body)?.transforms?.[0] ?? null
}

/** Fetch a transform's running state; 'stopped' when it cannot be determined (e.g. absent). */
export async function getTransformState(client: ElasticClient, id: string): Promise<TransformState> {
  const res = await client.elasticsearch('GET', `/_transform/${encodeURIComponent(id)}/_stats`)
  if (!res.ok) return 'stopped'
  const state = parseJson<LiveTransformStatsResponse>(res.body)?.transforms?.[0]?.state
  return state ?? 'stopped'
}

/**
 * Converge the transform's running state to the desired "enabled" flag:
 * start a stopped transform when enabled, stop a running one when disabled.
 * Idempotent — a transform already in the desired state is left alone.
 */
export async function converge(client: ElasticClient, id: string, enabled: boolean): Promise<void> {
  const state = await getTransformState(client, id)
  const running = state === 'started' || state === 'indexing'

  if (enabled && !running) {
    const res = await client.elasticsearch('POST', `/_transform/${encodeURIComponent(id)}/_start`)
    if (!res.ok) throw new Error(`Failed to start transform "${id}": ${elasticErrorMessage(res)}`)
  } else if (!enabled && running) {
    const res = await client.elasticsearch('POST', `/_transform/${encodeURIComponent(id)}/_stop`, {
      query: { wait_for_completion: false },
    })
    if (!res.ok) throw new Error(`Failed to stop transform "${id}": ${elasticErrorMessage(res)}`)
  }
}

/** Build the CREATE body — the only time pivot/latest (and every other authored key) is sent. */
export function buildCreateBody(spec: TransformSpec, definition: Record<string, unknown>): Record<string, unknown> {
  return { ...definition, ...sharedFields(spec) }
}

/** Build the UPDATE body — pivot/latest is stripped (immutable; the _update endpoint rejects it). */
export function buildUpdateBody(spec: TransformSpec, definition: Record<string, unknown>): Record<string, unknown> {
  return { ...pickMutableKeys(definition), ...sharedFields(spec) }
}

/** source/dest/description are accepted by both create and update. */
function sharedFields(spec: TransformSpec): Record<string, unknown> {
  const source: Record<string, unknown> = { index: spec.sourceIndex }
  if (spec.sourceQueryJson) {
    const query = parseJsonObject(spec.sourceQueryJson)
    if (!query) throw new Error(`Transform "${spec.transformId}": Source Query is not a valid JSON object`)
    source.query = query
  }

  const dest: Record<string, unknown> = { index: spec.destIndex }
  if (spec.destPipeline) dest.pipeline = spec.destPipeline

  const body: Record<string, unknown> = { source, dest }
  if (spec.description !== undefined) body.description = spec.description
  return body
}
