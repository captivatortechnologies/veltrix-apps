import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage } from '../../lib/intune'
import { buildRemediationBody, restoreSpec } from './remediation'
import { assignRemediation, type RemediationRollbackEntry } from './deploy'

/**
 * Roll back device remediations using the state captured during deploy: remediations
 * this deploy created are deleted; remediations it updated are restored to their prior
 * scripts/fields (re-encoded from the DECODED capture) and re-assigned to prior groups.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RemediationRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/deviceManagement/deviceHealthScripts/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete remediation "${entry.name}": ${graphErrorMessage(res)}`)
        }
      } else if (entry.id && entry.prior) {
        const spec = restoreSpec(entry.name, entry.prior)
        const res = await client.request('PATCH', `/deviceManagement/deviceHealthScripts/${entry.id}`, { body: buildRemediationBody(spec) })
        if (!res.ok) throw new Error(`Failed to restore remediation "${entry.name}": ${graphErrorMessage(res)}`)
        // Only restore assignments if THIS deploy managed them (else leave live/manual ones).
        if (entry.managedAssignments) await assignRemediation(client, entry.id, spec)
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} device remediation(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
