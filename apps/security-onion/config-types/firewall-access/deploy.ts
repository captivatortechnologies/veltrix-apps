import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { soCommand, applyHighstate, SO_CMD } from '../../lib/soConsole'

/**
 * Apply firewall access on the manager: `so-firewall includehost|excludehost
 * <group> <host>` for each item, then a Salt highstate so the change converges
 * across the grid. Runs over managed ZTNA (ctx.remote.command); soConsole
 * .requireRemote throws a clear message if the manager isn't reachable that way.
 *
 * rollbackData records exactly what we set so rollback can undo it (apply the
 * inverse include/exclude per host) — Security Onion exposes no verified prior
 * membership read over the declared command set, so an inverse-undo is the honest
 * rollback semantics.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const applied: Array<{ group: string; host: string; action: string }> = []

  try {
    for (const item of items) {
      const group = String(item.fields.group ?? '').trim()
      const host = String(item.fields.host ?? '').trim()
      const action = String(item.fields.action ?? 'include')
      if (!group || !host) continue
      await soCommand(ctx.remote, SO_CMD.soFirewall, { action: action === 'exclude' ? 'excludehost' : 'includehost', group, host })
      applied.push({ group, host, action })
    }

    if (applied.length > 0) await applyHighstate(ctx.remote)

    return {
      success: true,
      message: `Applied ${applied.length} firewall access change(s): ${applied.map((a) => `${a.action} ${a.host}→${a.group}`).join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { applied },
    }
  } catch (error) {
    return {
      success: false,
      message: `Firewall access deploy failed after ${applied.length} change(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { applied },
    }
  }
}
