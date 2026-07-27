import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findImagePolicyByName } from './deploy'
import {
  extractImagePolicySpecs,
  parseImagePolicyConditions,
  type LiveImagePolicy,
} from './validate'

/**
 * Detect drift between the deployed image assessment policy configuration and
 * the live tenant state. Looks up each declared policy and diffs enablement,
 * action, declared conditions, and description.
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

  const specs = extractImagePolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findImagePolicyByName(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Enablement decides whether the policy evaluates anything
      const liveEnabled = live.is_enabled === true
      if (liveEnabled !== spec.enabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: spec.enabled,
          actual: liveEnabled,
          // A policy that should be on but is off assesses nothing
          severity: spec.enabled && !liveEnabled ? 'critical' : 'warning',
        })
      }

      // Action (allow/alert/prevent) is the most consequential field
      const liveAction = firstRuleAction(live)
      if (liveAction !== spec.action) {
        diffs.push({
          field: `${spec.name}.action`,
          expected: spec.action,
          actual: liveAction ?? 'not set',
          severity: 'critical',
        })
      }

      // Declared conditions vs live conditions (subset match — extra live keys
      // are not counted as drift, mirroring the prevention-policy approach).
      const { conditions: declared } = parseImagePolicyConditions(spec.rulesRaw)
      const liveConditions = firstRuleConditions(live)
      const missing = declared.filter((cond) => !liveConditions.some((lc) => conditionMatches(cond, lc)))
      if (missing.length > 0) {
        diffs.push({
          field: `${spec.name}.rules`,
          expected: JSON.stringify(declared),
          actual: JSON.stringify(liveConditions),
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

      // Attribute every diff this policy produced to Falcon's recorded last
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

/** The action of the policy's first rule, or undefined when it has none. */
function firstRuleAction(live: LiveImagePolicy): string | undefined {
  const action = live.policy_data?.rules?.[0]?.action
  return typeof action === 'string' ? action.toLowerCase() : undefined
}

/** The conditions of the policy's first rule. */
function firstRuleConditions(live: LiveImagePolicy): Array<Record<string, unknown>> {
  const conditions = live.policy_data?.rules?.[0]?.policy_rules_data?.conditions
  return Array.isArray(conditions) ? (conditions as Array<Record<string, unknown>>) : []
}

/** A declared condition matches when every key it declares equals the live one. */
function conditionMatches(declared: Record<string, unknown>, live: Record<string, unknown>): boolean {
  return Object.entries(declared).every(
    ([key, value]) => JSON.stringify(live[key]) === JSON.stringify(value),
  )
}
