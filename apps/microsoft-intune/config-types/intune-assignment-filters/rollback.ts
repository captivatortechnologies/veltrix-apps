import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage } from '../../lib/intune'
import { FILTERS_PATH, type FilterRollbackEntry } from './deploy'

const FILTER_ODATA_TYPE = '#microsoft.graph.deviceAndAppManagementAssignmentFilter'

/**
 * Roll back assignment filters using the state captured during deploy: filters
 * this deploy created are deleted; filters it updated are restored to their prior
 * name/description/rule/management type (platform is immutable, so it is never
 * restored — it was never changed).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: FilterRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${FILTERS_PATH}/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete assignment filter "${entry.name}": ${graphErrorMessage(res)}`)
        }
      } else if (entry.id && entry.prior) {
        const body = {
          '@odata.type': FILTER_ODATA_TYPE,
          displayName: entry.prior.displayName ?? entry.name,
          description: entry.prior.description ?? '',
          rule: entry.prior.rule ?? '',
          assignmentFilterManagementType: entry.prior.assignmentFilterManagementType ?? 'devices',
          roleScopeTags: entry.prior.roleScopeTags ?? ['0'],
        }
        const res = await client.request('PATCH', `${FILTERS_PATH}/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore assignment filter "${entry.name}": ${graphErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} assignment filter(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
