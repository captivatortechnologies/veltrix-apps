import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import {
  controlId,
  deleteControl,
  findControl,
  replaceControlRules,
  updateControl,
} from './controlApi'
import type { ControlRollbackEntry } from './deploy'

/**
 * Roll back custom compliance controls using the state captured during deploy:
 *   - controls that were created are deleted (their rule assignments go with them)
 *   - controls that were updated are patched back to their prior description and
 *     their prior rule assignments are restored
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ControlRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this control — delete it by the id captured at create,
        // since a just-created control may not be returned by the query endpoint
        // yet (querying first could leak it). Fall back to a name lookup only when
        // no id was captured.
        const uuid =
          entry.uuid ??
          controlId(
            await findControl(client, {
              name: entry.name,
              frameworkId: entry.frameworkId,
              section: entry.section,
            }),
          )
        if (uuid) await deleteControl(client, uuid)
      } else if (entry.uuid && entry.prior) {
        // Deploy updated this control — restore the captured prior values.
        await updateControl(client, entry.uuid, {
          name: entry.name,
          description: entry.prior.description,
        })
        await replaceControlRules(client, entry.uuid, entry.prior.ruleIds)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} compliance control(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} control(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
