import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { soCommand, applyHighstate, SO_CMD } from '../../lib/soConsole'

const INVERSE: Record<string, string> = { enable: 'disable', disable: 'enable' }

/**
 * Undo a Suricata-rules deploy by applying the inverse state for each SID the
 * deploy set, then a Salt highstate. rollbackData.applied is written by deploy().
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { applied?: Array<{ sid: string; action: string }> }
  const applied = data.applied ?? []
  if (applied.length === 0) return { success: true, message: 'Nothing to roll back.' }

  try {
    for (const { sid, action } of applied) {
      await soCommand(ctx.remote, SO_CMD.soRule, { action: INVERSE[action] ?? 'enable', sid })
    }
    await applyHighstate(ctx.remote)
    return { success: true, message: `Reverted ${applied.length} Suricata rule state(s).` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
