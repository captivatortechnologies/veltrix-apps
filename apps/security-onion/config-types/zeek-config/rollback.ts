import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { soCommand, applyHighstate, SO_CMD } from '../../lib/soConsole'

const INVERSE: Record<string, string> = { enable: 'disable', disable: 'enable' }

/**
 * Undo a zeek-config deploy by applying the inverse state for each log type the
 * deploy set, then a Salt highstate. rollbackData.applied is written by deploy().
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { applied?: Array<{ logType: string; action: string }> }
  const applied = data.applied ?? []
  if (applied.length === 0) return { success: true, message: 'Nothing to roll back.' }

  try {
    for (const { logType, action } of applied) {
      await soCommand(ctx.remote, SO_CMD.zeekToggle, { action: INVERSE[action] ?? 'enable', logtype: logType })
    }
    await applyHighstate(ctx.remote)
    return { success: true, message: `Reverted ${applied.length} Zeek log-type state(s).` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
