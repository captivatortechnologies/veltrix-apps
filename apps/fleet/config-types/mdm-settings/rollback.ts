import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { setMdm } from './_shared'

interface PriorMdm {
  teamId: number | undefined
  priorMdm: Record<string, unknown>
}

/**
 * Undo an MDM-settings deploy from rollbackData.previous (written by
 * deploy()): for each scope, PATCH the prior `mdm` block back. Verify against
 * a live Fleet (fleetdm) instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorMdm[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for MDM-settings rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  try {
    for (const { teamId, priorMdm } of previous) {
      await setMdm(base, headers, { teamId }, priorMdm)
      restored++
    }
    return { success: true, message: `Restored MDM settings for ${restored} scope(s).` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
