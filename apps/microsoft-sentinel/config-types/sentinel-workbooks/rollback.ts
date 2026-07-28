import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage } from '../../lib/sentinel'
import {
  buildWorkbookBody,
  resolveWorkspaceLocation,
  workbookResourcePath,
  workspaceSourceId,
  type WorkbookRollbackEntry,
} from './deploy'
import { WORKBOOKS_API_VERSION } from './validate'

/**
 * Roll back workbooks using the state captured during deploy: workbooks this
 * deploy created (by minted GUID) are deleted; workbooks it updated are restored
 * to their prior serializedData/displayName via a PUT to the SAME GUID. The
 * workspace region and sourceId are re-resolved because a restore PUT needs them.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: WorkbookRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    const sourceId = workspaceSourceId(client)
    // Only resolved (once) if a restore actually needs it.
    let location: string | null = null

    for (const entry of [...previousState].reverse()) {
      const path = workbookResourcePath(client, entry.guid)
      if (!entry.existed) {
        // Delete a workbook this deploy created. 204 = already gone, treated as OK.
        const res = await client.request('DELETE', path, { apiVersion: WORKBOOKS_API_VERSION })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete workbook "${entry.displayName}": ${armErrorMessage(res)}`)
        }
      } else if (entry.prior?.serializedData != null) {
        if (!location) location = await resolveWorkspaceLocation(client)
        const body = buildWorkbookBody(
          { displayName: entry.prior.displayName ?? entry.displayName, serializedData: entry.prior.serializedData },
          location,
          sourceId,
          entry.prior.version,
        )
        const res = await client.request('PUT', path, { apiVersion: WORKBOOKS_API_VERSION, body })
        if (!res.ok) throw new Error(`Failed to restore workbook "${entry.displayName}": ${armErrorMessage(res)}`)
      }
      reverted.push(entry.displayName)
    }
    return { success: true, message: `Rolled back ${reverted.length} workbook(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
