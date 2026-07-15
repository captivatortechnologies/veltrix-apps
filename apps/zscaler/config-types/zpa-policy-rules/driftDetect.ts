import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listPolicyRules } from './deploy'
import { extractPolicyRuleSpecs, type LivePolicyRule } from './validate'

/**
 * Detect drift between the deployed policy rule configuration and the live
 * tenant. Re-finds each declared rule by name within its policy set and diffs
 * presence + the action field; a missing rule is critical drift.
 *
 * NOTE: the match conditions are intentionally NOT diffed. ZPA server-side
 * normalizes the operand DSL (rewrites the array, injects object ids, reorders
 * operands), so a byte-for-byte comparison against what was submitted would
 * report drift on every check even when nothing changed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  if (!client.hasCustomerId) return { hasDrift: false, diffs: [] }

  const specs = extractPolicyRuleSpecs(ctx.deployedConfig).filter((s) => s.name && s.policyType)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    // Load each targeted policy set's rules once, indexed by name.
    const rulesByType = new Map<string, Map<string, LivePolicyRule>>()
    for (const type of new Set(specs.map((s) => s.policyType))) {
      const live = await listPolicyRules(client, type)
      rulesByType.set(type, new Map(live.filter((r) => r.name).map((r) => [r.name as string, r])))
    }

    for (const spec of specs) {
      const found = rulesByType.get(spec.policyType)?.get(spec.name)
      const label = `${spec.policyType}/${spec.name}`
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const liveAction = typeof found.action === 'string' ? found.action : ''
      const specAction = spec.action ?? ''
      if (specAction !== liveAction) {
        diffs.push({
          field: `${label}.action`,
          expected: specAction || 'not set',
          actual: liveAction || 'not set',
          severity: 'warning',
        })
      }
      // conditions are server-normalized (see the file header) — not diffed.
    }
  } catch (error) {
    diffs.push({
      field: 'zpa',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
