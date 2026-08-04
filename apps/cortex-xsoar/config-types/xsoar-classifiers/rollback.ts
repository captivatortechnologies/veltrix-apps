import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import { deleteClassification, saveClassification } from '../lib/xsoarClassification'
import type { ClassifierRollbackEntry } from './deploy'

/**
 * Roll back classifiers using the state captured during deploy:
 *   - classifiers that were created are deleted (best-effort — see
 *     lib/xsoarClassification.ts `deleteClassification` for the
 *     delete-convention caveat)
 *   - classifiers that were updated are restored (POST /classifier/import) to
 *     their prior body
 * A classifier already deleted out-of-band (404) is treated as success.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ClassifierRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        await deleteClassification(client, entry.id)
      } else if (entry.prior) {
        await saveClassification(client, entry.id, { ...entry.prior, id: entry.id })
      }
      reverted.push(entry.id)
    }

    return { success: true, message: `Rolled back ${reverted.length} classifier(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
