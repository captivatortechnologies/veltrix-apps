import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'
import { buildSlaBody, type RubrikSlaDomain } from './_shared'

interface RollbackEntry {
  name: string
  existed: boolean
  id: string | null
  prior: RubrikSlaDomain | null
}

/**
 * Undo an SLA Domains deploy from rollbackData.previous (written by deploy()):
 *   - a SLA we CREATED (existed=false): DELETE /api/v2/sla_domain/{id}
 *   - a SLA we UPDATED (existed=true):  PATCH  /api/v2/sla_domain/{id} with the prior body
 * An entry whose id we never learned is skipped (nothing safe to undo).
 * Applied over the Rubrik CDM v2 REST API. Verify against a live Rubrik CDM.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveServiceAccount(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch (error) {
    return { success: false, message: `Rubrik connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.id) {
        skipped++
        continue
      }
      const path = `/api/v2/sla_domain/${encodeURIComponent(entry.id)}`
      if (entry.existed && entry.prior) {
        await sendJson(conn, 'PATCH', path, buildSlaBody(toFields(entry.prior)))
        restored++
      } else {
        await sendJson(conn, 'DELETE', path)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back SLA Domains: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

/** Re-derive the canvas-shaped fields from a prior live SLA so buildSlaBody re-emits it. */
function toFields(prior: RubrikSlaDomain): Record<string, unknown> {
  const f = prior.frequencies ?? {}
  return {
    name: prior.name,
    description: prior.description,
    hourlyFrequency: f.hourly?.frequency ?? 0,
    hourlyRetention: f.hourly?.retention ?? 0,
    dailyFrequency: f.daily?.frequency ?? 0,
    dailyRetention: f.daily?.retention ?? 0,
    weeklyFrequency: f.weekly?.frequency ?? 0,
    weeklyRetention: f.weekly?.retention ?? 0,
    weeklyDayOfWeek: f.weekly?.dayOfWeek ?? 'Sunday',
    monthlyFrequency: f.monthly?.frequency ?? 0,
    monthlyRetention: f.monthly?.retention ?? 0,
    monthlyDayOfMonth: f.monthly?.dayOfMonth ?? 'LastDay',
  }
}
