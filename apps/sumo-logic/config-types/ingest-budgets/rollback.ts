import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'
import type { IngestBudget } from './_shared'

/**
 * Undo an ingest-budgets deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /ingestBudgets/<id> with the prior full body
 * (restore), or — when the budget was newly created (prior body null) — DELETE
 * /ingestBudgets/<id> to remove it. Applied over the Sumo Logic Management API v2.
 *
 * API: https://help.sumologic.com/docs/api/ingest-budget-v2/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; budgetId: string | null; budget: IngestBudget | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for ingest budget rollback' }
  }

  const base = buildBaseUrl(component, connectivity, 'v2')
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { budgetId, budget } of previous) {
      if (budgetId == null) {
        // A created budget whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/ingestBudgets/${encodeURIComponent(budgetId)}`
      if (budget) {
        const { id: _omit, usageBytes: _u, usageStatus: _s, ...body } = budget
        await sendJson('PUT', path, headers, body)
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back ingest budgets: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
