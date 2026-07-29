import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { soCommand, applyHighstate, SO_CMD } from '../../lib/soConsole'

/**
 * SCOPE: this type manages enable/disable of EXISTING SOC users only. User
 * creation + password set requires interactive/stdin input (so-user add), which
 * the remote command seam does not support — a documented follow-up.
 *
 * Apply SOC user state on the manager: `so-user <enable|disable> <email>` for each
 * item, then a Salt highstate so the change converges across the grid. Runs over
 * managed ZTNA (ctx.remote.command); soConsole.requireRemote throws a clear message
 * if the manager isn't reachable that way.
 *
 * rollbackData records exactly what we set so rollback can undo it (apply the
 * inverse state per user) — an inverse-undo is the honest rollback semantics over
 * the declared command set.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const applied: Array<{ email: string; action: string }> = []

  try {
    for (const item of items) {
      const email = String(item.fields.email ?? '').trim()
      const action = String(item.fields.action ?? 'disable')
      if (!email) continue
      await soCommand(ctx.remote, SO_CMD.soUser, { action, email })
      applied.push({ email, action })
    }

    if (applied.length > 0) await applyHighstate(ctx.remote)

    return {
      success: true,
      message: `Applied ${applied.length} SOC user state(s): ${applied.map((a) => `${a.email}=${a.action}`).join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { applied },
    }
  } catch (error) {
    return {
      success: false,
      message: `SOC user deploy failed after ${applied.length} user(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { applied },
    }
  }
}
