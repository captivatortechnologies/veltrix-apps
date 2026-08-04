import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { batchReplaceProfiles, priorToBatchEntry, type PriorProfile } from './_shared'

/**
 * Undo a configuration-profile deploy from rollbackData.priorByTeam (written by
 * deploy()): for each team scope, replay the SAME batch-replace endpoint with
 * the captured prior profile content, restoring the scope's exact prior list
 * (an empty prior list restores "no profiles"). Applied over the Fleet REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    priorByTeam?: Array<{ teamId: number | undefined; profiles: PriorProfile[] }>
  }
  const priorByTeam = data.priorByTeam ?? []
  if (priorByTeam.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for configuration-profile rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restoredScopes = 0
  let restoredProfiles = 0
  try {
    for (const { teamId, profiles } of priorByTeam) {
      const entries = profiles.map(priorToBatchEntry)
      await batchReplaceProfiles(base, headers, teamId, entries)
      restoredScopes++
      restoredProfiles += profiles.length
    }
    return {
      success: true,
      message: `Restored configuration profiles for ${restoredScopes} scope(s), ${restoredProfiles} profile(s) total.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
