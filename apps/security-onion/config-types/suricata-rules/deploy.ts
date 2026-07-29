import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { soCommand, applyHighstate, SO_CMD } from '../../lib/soConsole'

/**
 * Apply Suricata rule state on the manager: `so-rule <enable|disable> <sid>` for
 * each item, then a Salt highstate so the change converges across sensors. Runs
 * over managed ZTNA (ctx.remote.command); soConsole.requireRemote throws a clear
 * message if the manager isn't reachable that way.
 *
 * rollbackData records exactly what we set so rollback can undo it (apply the
 * inverse state per SID) — Security Onion has no per-SID prior-state read over the
 * declared command set, so an inverse-undo is the honest rollback semantics.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const applied: Array<{ sid: string; action: string }> = []

  try {
    for (const item of items) {
      const sid = String(item.fields.sid ?? '').trim()
      const action = String(item.fields.action ?? 'disable')
      if (!sid) continue
      await soCommand(ctx.remote, SO_CMD.soRule, { action, sid })
      applied.push({ sid, action })
    }

    if (applied.length > 0) await applyHighstate(ctx.remote)

    return {
      success: true,
      message: `Applied ${applied.length} Suricata rule state(s): ${applied.map((a) => `${a.sid}=${a.action}`).join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { applied },
    }
  } catch (error) {
    return {
      success: false,
      message: `Suricata rule deploy failed after ${applied.length} rule(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { applied },
    }
  }
}
