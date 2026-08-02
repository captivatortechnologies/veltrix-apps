import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, getL7FirewallRules } from '../../lib/merakiApi'
import { canonicalJson, extractL7FirewallRuleSpecs, normalizeL7Rule, parseL7Rules } from './_shared'

/**
 * Detect drift between the deployed L7 firewall ruleset and the live network:
 * for each declared network, GET the live ordered ruleset and compare it
 * (order-sensitive) against the declared ruleset. A network that can't be read
 * is critical drift; a differing rule list is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractL7FirewallRuleSpecs(ctx.deployedConfig).filter((s) => s.networkId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  for (const spec of specs) {
    const { rules: parsedRules, error } = parseL7Rules(spec.rulesRaw)
    if (error || !parsedRules) continue
    const expectedRules = parsedRules.map((r) => normalizeL7Rule(r))

    try {
      const live = await getL7FirewallRules(client, spec.networkId)
      const expectedJson = canonicalJson(expectedRules)
      const actualJson = canonicalJson((live.rules ?? []).map((r) => normalizeL7Rule(r)))
      if (expectedJson !== actualJson) {
        diffs.push({
          field: `${spec.networkId}.rules`,
          expected: expectedRules,
          actual: live.rules ?? [],
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.networkId,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown error'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
