import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { setSecretsForScope } from './_shared'

/**
 * Undo an enroll-secret deploy from rollbackData.priorByScope (written by
 * deploy()): for each scope, replay the same whole-list-replace endpoint with
 * the captured prior secret list, restoring the scope's exact prior state.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { priorByScope?: Array<{ teamId: number | undefined; secrets: string[] }> }
  const priorByScope = data.priorByScope ?? []
  if (priorByScope.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for enroll-secret rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restoredScopes = 0
  try {
    for (const { teamId, secrets } of priorByScope) {
      await setSecretsForScope(base, headers, teamId, secrets)
      restoredScopes++
    }
    return { success: true, message: `Restored enroll secrets for ${restoredScopes} scope(s).` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
