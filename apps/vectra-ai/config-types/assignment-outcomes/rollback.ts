import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, sendJson } from '../../lib/vectraApi'
import { buildOutcomeBody, type VectraAssignmentOutcome } from './_shared'

/**
 * Undo an assignment-outcomes deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /assignment_outcomes/<id> with the prior body
 * (restore), or — when the outcome was newly created (prior body null) — DELETE
 * /assignment_outcomes/<id> to remove it. Applied over the Vectra Detect REST API
 * (v2.5, 443).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ title: string; outcomeId: number | string | null; outcome: VectraAssignmentOutcome | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for assignment outcome rollback' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { outcomeId, outcome } of previous) {
      if (outcomeId == null) {
        // A created outcome whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (outcome) {
        await sendJson('PUT', `${base}/assignment_outcomes/${encodeURIComponent(String(outcomeId))}`, headers, buildOutcomeBody(outcome))
        restored++
      } else {
        await sendJson('DELETE', `${base}/assignment_outcomes/${encodeURIComponent(String(outcomeId))}`, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back assignment outcomes: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
