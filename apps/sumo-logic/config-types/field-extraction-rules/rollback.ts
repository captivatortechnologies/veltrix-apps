import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'
import type { ExtractionRule } from './_shared'

/**
 * Undo a field-extraction-rules deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /extractionRules/<id> with the prior rule body
 * (restore), or — when the rule was newly created (prior body null) — DELETE
 * /extractionRules/<id> to remove it. Applied over the Sumo Logic Management API.
 *
 * API: https://www.sumologic.com/help/docs/api/field-extraction-rules/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; ruleId: string | null; rule: ExtractionRule | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for field extraction rule rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

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
      const path = `${base}/extractionRules/${encodeURIComponent(ruleId)}`
      if (rule) {
        const { id: _omit, ...body } = rule
        await sendJson('PUT', path, headers, body)
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back field extraction rules: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
