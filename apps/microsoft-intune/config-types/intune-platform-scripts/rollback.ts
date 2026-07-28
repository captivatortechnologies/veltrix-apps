import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage } from '../../lib/intune'
import { assignScript, type ScriptRollbackEntry } from './deploy'
import { DEVICE_MANAGEMENT_SCRIPT_ODATA_TYPE } from './validate'

/**
 * Roll back platform scripts using the state captured during deploy: scripts this
 * deploy created are deleted; scripts it updated are restored to their prior
 * description/fields (file name, base64 scriptContent, run-as account, flags) and
 * prior assignments, when this deploy managed them.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScriptRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/deviceManagement/deviceManagementScripts/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete platform script "${entry.name}": ${graphErrorMessage(res)}`)
        }
      } else if (entry.id && entry.prior) {
        const body = {
          '@odata.type': DEVICE_MANAGEMENT_SCRIPT_ODATA_TYPE,
          displayName: entry.name,
          description: entry.prior.description ?? '',
          roleScopeTagIds: ['0'],
          ...(entry.prior.fields ?? {}),
        }
        const res = await client.request('PATCH', `/deviceManagement/deviceManagementScripts/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore platform script "${entry.name}": ${graphErrorMessage(res)}`)
        if (entry.managedAssignments && entry.prior.assignments) {
          await assignScript(client, entry.id, entry.prior.assignments, entry.name)
        }
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} platform script(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
