import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient } from '../../lib/orcaApi'
import { readSystemAlert, setSystemAlertEnabled, type AlertExceptionRollbackData } from './_shared'

/**
 * Undo an alert-exceptions deploy from rollbackData.previous (written by
 * deploy()): PUT /api/sonar/rules/status/{rule_id} back to `priorEnabled` for
 * every recorded entry. There is no delete branch — a system alert can never
 * be removed by this app, only toggled — so rollback is always a restore. An
 * entry whose rule can no longer be read (e.g. deleted out of band, though
 * Orca does not expose that for system alerts) is skipped rather than failing
 * the whole rollback.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as AlertExceptionRollbackData
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let restored = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.ruleId) {
        skipped++
        continue
      }
      const live = await readSystemAlert(client, entry.ruleId)
      if (!live || !live.rule_type) {
        skipped++
        continue
      }
      const result = await setSystemAlertEnabled(client, entry.ruleId, live.rule_type, entry.priorEnabled)
      if (!result.ok) throw new Error(`restore alert exception "${entry.ruleId}" failed: ${result.error}`)
      restored++
    }
    return {
      success: true,
      message: `Rolled back alert exceptions: ${restored} restored${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
