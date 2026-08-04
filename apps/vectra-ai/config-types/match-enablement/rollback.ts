import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, sendJson } from '../../lib/vectraApi'

/**
 * Undo a match-enablement deploy from rollbackData.previous (written by deploy()):
 * POST each sensor's prior enablement state back. A sensor whose prior state
 * couldn't be read (null) is skipped rather than guessed. Applied over the Vectra
 * Detect REST API (v2.5, 443).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ deviceSerial: string; enabled: boolean | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for match enablement rollback' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let skipped = 0
  try {
    for (const { deviceSerial, enabled } of previous) {
      if (enabled == null) {
        skipped++
        continue
      }
      await sendJson('POST', `${base}/vectra-match/enablement`, headers, { device_serial: deviceSerial, desired_state: enabled })
      restored++
    }
    return { success: true, message: `Rolled back match enablement: ${restored} restored${skipped ? `, ${skipped} skipped` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
