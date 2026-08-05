import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient, qualysWriteError, type QualysParams } from '../../lib/qualys'
import { authRecordPath, type AuthRecordRollbackEntry } from './deploy'

/**
 * Roll back authentication records using the state captured during deploy:
 *   - records that were created are deleted (action=delete)
 *   - records that were updated are best-effort restored (action=update) to
 *     their prior title/comments. The list API never returns credentials (they
 *     are write-only), so passwords/keys/vault settings are not restored —
 *     created records roll back cleanly; updated records keep whatever
 *     credential material is currently live.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AuthRecordRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      const path = authRecordPath(entry.recordType)
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.post(path, { action: 'delete', ids: entry.id })
          const failed = qualysWriteError(res)
          // A 404 / already-deleted record is not a rollback failure.
          if (failed && res.status !== 404) {
            throw new Error(`Failed to delete ${entry.label} authentication record: ${failed}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const params: QualysParams = {
          action: 'update',
          ids: entry.id,
          title: entry.prior.title,
          comments: entry.prior.comments,
        }
        const res = await client.post(path, params)
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to restore ${entry.label} authentication record: ${failed}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} authentication record(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
