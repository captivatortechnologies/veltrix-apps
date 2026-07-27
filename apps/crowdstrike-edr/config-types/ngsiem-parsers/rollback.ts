import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteParser, updateParser, type ParserRollbackEntry } from './deploy'

/**
 * Roll back Next-Gen SIEM parsers using the state captured during deploy:
 *   - parsers that were created are deleted
 *   - parsers that were updated are patched back to their prior script
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ParserRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this parser — remove it. A 404 means it never finished
        // creating or is already gone, which is the desired state.
        if (entry.id) {
          await deleteParser(client, entry.id, entry.repository)
        }
      } else if (entry.id && entry.prior && typeof entry.prior.script === 'string') {
        // Deploy updated this parser — restore the captured prior script.
        await updateParser(client, {
          id: entry.id,
          name: entry.name,
          repository: entry.repository,
          script: entry.prior.script,
        })
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} Next-Gen SIEM parser(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} parser(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
