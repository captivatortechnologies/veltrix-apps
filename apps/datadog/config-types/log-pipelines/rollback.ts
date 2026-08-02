import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage } from '../../lib/datadogApi'
import { pipelineToBody } from './_shared'
import type { PipelineRollbackEntry } from './deploy'

const PIPELINES_PATH = '/api/v1/logs/config/pipelines'

/**
 * Roll back Log Pipelines using the state captured during deploy:
 *   - pipelines that were CREATED are deleted
 *     (DELETE /api/v1/logs/config/pipelines/{pipeline_id}; 404 tolerated)
 *   - pipelines that were UPDATED are restored (PUT, full-replace) to their
 *     captured prior body. Unlike Security Monitoring Rules, pipeline updates
 *     carry no optimistic-concurrency `version` field (not documented for
 *     this API), so no fresh re-read is needed before restoring.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PipelineRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${PIPELINES_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete pipeline "${entry.label}": ${datadogErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const body = pipelineToBody(entry.prior)
        const res = await client.request('PUT', `${PIPELINES_PATH}/${encodeURIComponent(entry.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to restore pipeline "${entry.label}": ${datadogErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Log Pipeline(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
