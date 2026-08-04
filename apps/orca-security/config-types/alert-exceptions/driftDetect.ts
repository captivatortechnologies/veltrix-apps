import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOrcaClient } from '../../lib/orcaApi'
import { normalizeEnabled, readSystemAlert } from './_shared'

/**
 * Drift for alert exceptions: for each declared item, GET the live built-in
 * alert by its rule_id and compare its enabled state against what we declare.
 * Best-effort — a rule_id that can't be read is skipped rather than raising
 * false drift (it will surface as a deploy failure instead). Read-only:
 * GET /api/sonar/rules/{rule_id}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const ruleId = String(item.fields.ruleId ?? '').trim()
    if (!ruleId) continue

    const live = await readSystemAlert(client, ruleId)
    if (!live) continue

    const expected = normalizeEnabled(item.fields.enabled, true)
    const actual = normalizeEnabled(live.enabled, true)
    if (expected !== actual) {
      diffs.push({ field: `${ruleId}.enabled`, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
