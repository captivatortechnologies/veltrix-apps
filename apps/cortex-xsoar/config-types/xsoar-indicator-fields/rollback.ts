import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import { deleteField, saveField } from '../lib/xsoarFields'
import type { IndicatorFieldRollbackEntry } from './deploy'

/**
 * Roll back indicator fields using the state captured during deploy:
 *   - fields that were created are deleted (best-effort — see
 *     lib/xsoarFields.ts `deleteField` for the delete-convention caveat)
 *   - fields that were updated are restored (POST /incidentfields/import) to
 *     their prior body
 * A field already deleted out-of-band (404) is treated as success.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IndicatorFieldRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        await deleteField(client, entry.id)
      } else if (entry.prior) {
        await saveField(client, { ...entry.prior, id: entry.id })
      }
      reverted.push(entry.cliName)
    }

    return { success: true, message: `Rolled back ${reverted.length} indicator field(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
