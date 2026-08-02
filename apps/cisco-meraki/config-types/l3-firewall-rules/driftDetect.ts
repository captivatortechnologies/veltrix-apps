import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, getL3FirewallRules } from '../../lib/merakiApi'
import { canonicalJson, extractL3FirewallRuleSpecs, normalizeRule, parseRules } from './_shared'

/**
 * Detect drift between the deployed L3 firewall ruleset and the live network:
 * for each declared network, GET the live ordered ruleset and compare it
 * (order-sensitive — rule order changes the effective policy) against the
 * declared ruleset. A network that can't be read (deleted, no longer an MX
 * network, credential lost access, …) is critical drift; a differing rule list
 * is a warning.
 *
 * `syslog_default_rule` is NEVER diffed: Meraki does not return the live value
 * of that flag on GET, so there is nothing to compare it to — see deploy.ts /
 * rollback.ts for the same limitation.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractL3FirewallRuleSpecs(ctx.deployedConfig).filter((s) => s.networkId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  for (const spec of specs) {
    const { rules: parsedRules, error } = parseRules(spec.rulesRaw)
    if (error || !parsedRules) continue
    const expectedRules = parsedRules.map((r) => normalizeRule(r))

    try {
      const live = await getL3FirewallRules(client, spec.networkId)
      const expectedJson = canonicalJson(expectedRules)
      const actualJson = canonicalJson((live.rules ?? []).map((r) => normalizeRule(r)))
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
