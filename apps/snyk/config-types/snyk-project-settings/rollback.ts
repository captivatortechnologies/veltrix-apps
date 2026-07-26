import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { ProjectSettingsRollbackEntry } from './deploy'

/**
 * Roll back project settings using the state captured during deploy (in reverse
 * order):
 *   - a project that had explicit settings before is restored by PUTting its
 *     prior settings back in place
 *   - a project that had NO explicit settings before is reset to inherit its
 *     integration defaults via DELETE — the correct inverse of adding settings
 *     (a 404 is tolerated because the project may already be gone)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back project settings.' }
  }

  const previousState = (ctx.rollbackData as { previousState?: ProjectSettingsRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (entry.wasEmpty) {
        const res = await client.v1('DELETE', `${client.v1OrgPath()}/project/${entry.projectId}/settings`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to reset project "${entry.projectId}": ${snykErrorMessage(res)}`)
        }
      } else {
        const res = await client.v1('PUT', `${client.v1OrgPath()}/project/${entry.projectId}/settings`, {
          body: entry.prior,
        })
        if (!res.ok) {
          throw new Error(`Failed to restore project "${entry.projectId}": ${snykErrorMessage(res)}`)
        }
      }
      reverted.push(entry.projectId)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} project setting(s): ${reverted.join(', ') || 'none'}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
