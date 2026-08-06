import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import type { PolicyModuleStateRollbackEntry } from './deploy'

/**
 * Roll back policy module states.
 *
 * KNOWN LIMITATION: this CANNOT be automated. deploy.ts captures a
 * best-effort snapshot of policies.getPolicyDetails before applying, but
 * GravityZone documents no confirmed mapping from that read-back shape to
 * setPolicyModulesState's write-side "settings" input — replaying the
 * captured snapshot could silently send the wrong shape rather than restore
 * the prior module states. Rather than guess, this returns the captured
 * snapshot (as JSON, per policy) so an operator can restore it manually in
 * the Control Center console. See README.md "Known limitations".
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }

  const previous = (ctx.rollbackData as { previous?: PolicyModuleStateRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const notes = previous.map((entry) => {
    const snapshot = entry.priorDetails ? JSON.stringify(entry.priorDetails).slice(0, 400) : '(no prior details captured)'
    return `Policy "${entry.policyId}": ${snapshot}`
  })

  return {
    success: true,
    message:
      `${previous.length} policy(ies) require MANUAL restoration in the GravityZone Control Center console — ` +
      'this app cannot automatically replay setPolicyModulesState from a captured getPolicyDetails snapshot ' +
      '(see README.md "Known limitations"). Captured prior details: ' +
      notes.join(' | '),
  }
}
