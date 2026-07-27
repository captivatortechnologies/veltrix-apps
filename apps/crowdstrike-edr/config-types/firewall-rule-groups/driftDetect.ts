import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { canonicalFromLive, canonicalFromSpec, findRuleGroup, rulesEqual } from './deploy'
import { extractRuleGroupSpecs, parseFirewallRules } from './validate'

/**
 * Detect drift between the deployed firewall rule group configuration and the
 * live tenant state. Looks up each declared group and diffs enablement,
 * platform, description, and each declared rule's presence and fields. Because
 * the declared rules are the complete rule set, an undeclared live rule is
 * reported too (deploy would remove it).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractRuleGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findRuleGroup(client, spec.name, spec.platform)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Enablement decides whether the group enforces anything
      if (live.enabled !== spec.enabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: spec.enabled,
          actual: live.enabled ?? false,
          severity: 'critical',
        })
      }

      // Platform is immutable via the API — a mismatch means a different group
      const livePlatform = (live.platform ?? '').toLowerCase()
      if (livePlatform !== spec.platform) {
        diffs.push({
          field: `${spec.name}.platform`,
          expected: spec.platform,
          actual: livePlatform || 'unknown',
          severity: 'warning',
        })
      }

      // Declared rules vs live rules (presence + managed fields)
      const { rules } = parseFirewallRules(spec.rulesRaw)
      const declaredNames = new Set(rules.map((r) => r.name))
      const liveByName = new Map(
        (live.rules ?? []).filter((r) => typeof r.name === 'string').map((r) => [r.name as string, r]),
      )
      for (const rule of rules) {
        const match = liveByName.get(rule.name)
        if (!match) {
          diffs.push({
            field: `${spec.name}.rules.${rule.name}`,
            expected: 'present',
            actual: 'not present on group',
            severity: rule.enabled ? 'critical' : 'warning',
          })
          continue
        }
        if (!rulesEqual(canonicalFromSpec(rule), canonicalFromLive(match))) {
          diffs.push({
            field: `${spec.name}.rules.${rule.name}`,
            expected: `${rule.action} ${rule.direction} ${rule.protocol}`,
            actual: `${match.action ?? '?'} ${match.direction ?? '?'} protocol ${match.protocol ?? '?'}`,
            severity: 'warning',
          })
        }
      }

      // Undeclared live rules would be removed by the next deploy
      for (const liveRule of live.rules ?? []) {
        if (typeof liveRule.name === 'string' && !declaredNames.has(liveRule.name)) {
          diffs.push({
            field: `${spec.name}.rules.${liveRule.name}`,
            expected: 'not declared',
            actual: 'present on group (undeclared)',
            severity: 'warning',
          })
        }
      }

      const liveDescription = (live.description ?? '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // Attribute every diff this group produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
