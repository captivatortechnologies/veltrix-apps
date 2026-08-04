import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, sendJson } from '../../lib/vectraApi'
import type { InternalNetworksState } from './_shared'

/**
 * Undo an Internal Networks deploy from rollbackData.previous (written by deploy()):
 * POST the prior { include, exclude, drop } state back in full. Applied over the
 * Vectra Detect REST API (v2.5, 443).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: InternalNetworksState }
  const previous = data.previous

  if (!previous) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for internal networks rollback' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  try {
    await sendJson('POST', `${base}/settings/internal_network`, headers, previous)
    return {
      success: true,
      message: `Restored internal networks: ${previous.include.length} included, ${previous.exclude.length} excluded, ${previous.drop.length} dropped.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
