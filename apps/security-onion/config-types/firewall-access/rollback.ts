import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { soCommand, applyHighstate, SO_CMD } from '../../lib/soConsole'

const INVERSE: Record<string, string> = { include: 'exclude', exclude: 'include' }
const CLI: Record<string, string> = { include: 'includehost', exclude: 'excludehost' }

/**
 * Undo a firewall-access deploy by applying the inverse include/exclude for each
 * host the deploy set, then a Salt highstate. rollbackData.applied is written by
 * deploy().
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { applied?: Array<{ group: string; host: string; action: string }> }
  const applied = data.applied ?? []
  if (applied.length === 0) return { success: true, message: 'Nothing to roll back.' }

  try {
    for (const { group, host, action } of applied) {
      await soCommand(ctx.remote, SO_CMD.soFirewall, { action: CLI[INVERSE[action] ?? 'exclude'], group, host })
    }
    await applyHighstate(ctx.remote)
    return { success: true, message: `Reverted ${applied.length} firewall access change(s).` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
