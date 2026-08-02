import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { ignoreRulePath, type IgnoreRuleEntry } from './deploy'
import { extractIgnoreRuleSpecs } from './_shared'

/**
 * Detect drift for the last-deployed ignore-rule configuration.
 *
 * UNLIKE the policy/watch config types, this ONLY checks EXISTENCE (a rule
 * this app created is missing = CRITICAL drift) rather than content —
 * content cannot drift here: Xray has no update endpoint for ignore rules
 * (see deploy.ts), so nobody, including a manual console edit, can mutate a
 * rule's fields after creation. The only way a tracked rule differs from what
 * we declared is if it was deleted outright, which existence-checking already
 * catches. Best-effort and read-only: any transport failure reports no drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractIgnoreRuleSpecs(ctx.deployedConfig).filter((s) => s.notes && s.itemId)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let prior: IgnoreRuleEntry[]
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: IgnoreRuleEntry[] } | undefined
    prior = Array.isArray(data?.entries) ? data!.entries : []
  } catch {
    return { hasDrift: false, diffs }
  }
  const byItem = new Map(prior.filter((e) => e.itemId && e.ruleId).map((e) => [e.itemId, e]))

  for (const spec of specs) {
    const entry = byItem.get(spec.itemId as string)
    if (!entry) continue // never deployed — nothing to compare against

    try {
      const res = await client.request('GET', ignoreRulePath(entry.ruleId))
      if (!res.ok) {
        diffs.push({ field: spec.notes, expected: 'exists', actual: 'missing', severity: 'critical' })
      }
    } catch {
      // transport failure for this one item — skip rather than false-positive
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
