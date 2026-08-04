import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import type { LiveIngestPipeline } from './validate'
import type { IngestPipelineRollbackEntry } from './deploy'

/**
 * Roll back ingest pipelines using the state captured during deploy:
 *   - pipelines that were CREATED are deleted (DELETE /_ingest/pipeline/{id});
 *     a 404 means it is already gone, which is the desired end state.
 *   - pipelines that were UPDATED are restored (PUT) to their prior body.
 *
 * DELETE fails if the pipeline is still referenced by an index's default/final
 * pipeline setting or another pipeline's `pipeline` processor — that error is
 * surfaced rather than swallowed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IngestPipelineRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.elasticsearch('DELETE', `/_ingest/pipeline/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(
            `Failed to delete ingest pipeline "${entry.id}" (it may still be referenced by an index or another pipeline): ${elasticErrorMessage(res)}`,
          )
        }
      } else if (entry.prior) {
        const res = await client.elasticsearch('PUT', `/_ingest/pipeline/${encodeURIComponent(entry.id)}`, {
          body: buildRestoreBody(entry.prior),
        })
        if (!res.ok) {
          throw new Error(`Failed to restore ingest pipeline "${entry.id}": ${elasticErrorMessage(res)}`)
        }
      }

      reverted.push(entry.id)
    }

    return { success: true, message: `Rolled back ${reverted.length} ingest pipeline(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} pipeline(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild the upsert body from a captured prior pipeline, restoring it verbatim. */
function buildRestoreBody(prior: LiveIngestPipeline): Record<string, unknown> {
  const body: Record<string, unknown> = { processors: prior.processors ?? [] }
  if (prior.description !== undefined) body.description = prior.description
  if (prior.on_failure) body.on_failure = prior.on_failure
  if (prior.version !== undefined) body.version = prior.version
  if (prior._meta) body._meta = prior._meta
  return body
}
