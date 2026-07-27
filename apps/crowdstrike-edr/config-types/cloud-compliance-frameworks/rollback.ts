import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import {
  deleteFramework,
  findFrameworkByName,
  frameworkId,
  updateFramework,
} from './frameworkApi'
import type { FrameworkRollbackEntry } from './deploy'

/**
 * Roll back custom compliance frameworks using the state captured during
 * deploy:
 *   - frameworks that were created are deleted
 *   - frameworks that were updated are patched back to their prior values
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: FrameworkRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this framework — remove it. Re-resolve by identity so a
        // concurrent delete makes this a no-op instead of a hard error.
        const live = await findFrameworkByName(client, entry.name)
        const uuid = frameworkId(live)
        if (uuid) await deleteFramework(client, uuid)
      } else if (entry.uuid && entry.prior) {
        // Deploy updated this framework — restore the captured prior values.
        await updateFramework(client, entry.uuid, {
          name: entry.name,
          description: entry.prior.description,
          active: entry.prior.active,
        })
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} compliance framework(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} framework(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
