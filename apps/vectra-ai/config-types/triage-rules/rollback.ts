import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, sendJson } from '../../lib/vectraApi'
import type { VectraRule } from './_shared'

/**
 * Undo a triage-rules deploy from rollbackData.previous (written by deploy()): for
 * each entry, PUT /rules/<id> with the prior rule body (restore), or — when the
 * rule was newly created (prior body null) — DELETE /rules/<id>?restore_detections=true
 * to remove it and un-suppress any detections it hid. Applied over the Vectra
 * Detect REST API (v2.5, 443). Verify against a live Vectra brain.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ description: string; ruleId: number | string | null; rule: VectraRule | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for triage-rule rollback' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { ruleId, rule } of previous) {
      if (ruleId == null) {
        // A created rule whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (rule) {
        await sendJson('PUT', `${base}/rules/${encodeURIComponent(String(ruleId))}`, headers, rule)
        restored++
      } else {
        await sendJson('DELETE', `${base}/rules/${encodeURIComponent(String(ruleId))}?restore_detections=true`, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back triage rules: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
