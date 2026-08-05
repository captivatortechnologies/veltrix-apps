import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { deleteScanningExclusion, updateScanningExclusion } from '../../lib/sophosApi'
import type { ScanningExclusionRollbackEntry } from './deploy'

/**
 * Roll back scanning exclusions using the state captured during deploy:
 *   - created exclusions are deleted
 *   - patched exclusions have their prior scanMode/comment restored
 *   - unchanged exclusions are left alone
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: ScanningExclusionRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (entry.action === 'created') {
        if (entry.id) await deleteScanningExclusion(client, entry.id)
      } else if (entry.action === 'patched') {
        if (entry.id) await updateScanningExclusion(client, entry.id, { scanMode: entry.prior?.scanMode, comment: entry.prior?.comment })
      }
      reverted.push(entry.key)
    }
    return { success: true, message: `Rolled back ${reverted.length} scanning exclusion(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
