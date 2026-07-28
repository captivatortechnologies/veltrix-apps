import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage } from '../../lib/intune'
import { buildRestoreBody } from './compliance'
import { assignPolicy, type ComplianceRollbackEntry } from './deploy'

/**
 * Roll back compliance policies using the state captured during deploy: policies this
 * deploy created are deleted; policies it updated are restored to their prior fields
 * and re-assigned to their prior groups.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ComplianceRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/deviceManagement/deviceCompliancePolicies/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete compliance policy "${entry.name}": ${graphErrorMessage(res)}`)
        }
      } else if (entry.id && entry.prior && entry.platform) {
        const res = await client.request('PATCH', `/deviceManagement/deviceCompliancePolicies/${entry.id}`, {
          body: buildRestoreBody(entry.prior.fields, entry.platform),
        })
        if (!res.ok) throw new Error(`Failed to restore compliance policy "${entry.name}": ${graphErrorMessage(res)}`)
        await assignPolicy(client, entry.id, entry.prior.assignment)
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} compliance policy(ies): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
