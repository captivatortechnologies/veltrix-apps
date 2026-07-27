import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { getGroupByName, getRulesForGroup, ruleDiffers } from './deploy'
import { extractRuleGroupSpecs, parseRuleSpecs } from './validate'

/**
 * Detect drift between the deployed FileVantage rule group configuration and the
 * live tenant state. Looks up each declared group and diffs its type,
 * description, and the presence/configuration of declared rules (matched by
 * path). Undeclared live rules are intentionally ignored — this app never
 * manages rules it did not declare.
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
      const live = await getGroupByName(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Type is immutable via the API — a mismatch means a different group
      const liveType = (live.type ?? '').toLowerCase()
      if (liveType !== spec.type.toLowerCase()) {
        diffs.push({
          field: `${spec.name}.type`,
          expected: spec.type,
          actual: live.type ?? 'unknown',
          severity: 'warning',
        })
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

      // Declared rules vs live rules (presence + configuration), matched by path
      const { rules } = parseRuleSpecs(spec.rulesRaw)
      const liveRules = await getRulesForGroup(client, live)
      const liveByPath = new Map(
        liveRules
          .filter((r) => typeof r.path === 'string')
          .map((r) => [(r.path as string).toLowerCase(), r]),
      )
      for (const rule of rules) {
        const match = liveByPath.get(rule.path.toLowerCase())
        if (!match) {
          diffs.push({
            field: `${spec.name}.rules.${rule.path}`,
            expected: 'present',
            actual: 'not present on group',
            severity: 'warning',
          })
          continue
        }
        if (ruleDiffers(rule, match, spec.type)) {
          diffs.push({
            field: `${spec.name}.rules.${rule.path}`,
            expected: 'matches declared configuration',
            actual: 'configuration drifted',
            severity: 'warning',
          })
        }
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
