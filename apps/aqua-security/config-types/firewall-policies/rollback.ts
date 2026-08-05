import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAquaClient, type AquaFirewallPolicy } from '../../lib/aquasec'
import type { RollbackEntry } from '../lib/common'

/**
 * Undo a firewall-policies deploy from rollbackData.previous (written by
 * deploy()). Per entry, reverse the action taken:
 *   created → DELETE the policy we added
 *   updated → PUT the prior policy body back (restore)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry<AquaFirewallPolicy>[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let removed = 0
  let skipped = 0

  try {
    for (const entry of previous) {
      switch (entry.action) {
        case 'created':
          await client.deleteFirewallPolicy(entry.name)
          removed++
          break
        case 'updated':
          if (entry.prior) {
            await client.updateFirewallPolicy(entry.prior)
            restored++
          } else {
            skipped++
          }
          break
        default:
          skipped++
      }
    }

    return { success: true, message: `Rolled back firewall policies: ${restored} restored, ${removed} removed${skipped ? `, ${skipped} skipped` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
