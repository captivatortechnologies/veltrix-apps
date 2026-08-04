import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage } from '../../lib/datadogApi'
import { attributesToBody, toPayload } from './_shared'
import type { ArchiveRollbackEntry } from './deploy'

const ARCHIVES_PATH = '/api/v2/logs/config/archives'

/**
 * Roll back Log Archives using the state captured during deploy:
 *   - archives that were CREATED are deleted (DELETE .../{id}; 404 tolerated)
 *   - archives that were UPDATED are restored (PUT, full-replace) to their
 *     captured prior attributes.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ArchiveRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${ARCHIVES_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete archive "${entry.label}": ${datadogErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior?.attributes) {
        const body = attributesToBody(entry.prior.attributes)
        const res = await client.request('PUT', `${ARCHIVES_PATH}/${encodeURIComponent(entry.id)}`, { body: toPayload(body) })
        if (!res.ok) throw new Error(`Failed to restore archive "${entry.label}": ${datadogErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Log Archive(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
