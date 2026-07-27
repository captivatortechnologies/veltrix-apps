import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findRuleByName } from './deploy'
import { canonicalJson, extractIdpRuleSpecs, parseConditions } from './validate'

/**
 * Detect drift between the deployed Identity Protection policy rule
 * configuration and the live tenant state. Looks up each declared rule by name
 * and diffs the managed fields: enabled, simulationMode, action, and each
 * declared condition key.
 *
 * Attribution ("who changed it") is BEST-EFFORT: Identity Protection policy
 * rules are not documented to expose a modifier, so attachDriftActor is
 * typically a no-op here and diffs are reported without an actor. The wiring is
 * kept for parity with the other config types and in case a future API surfaces
 * modified_by/modified_on.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractIdpRuleSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findRuleByName(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // enabled decides whether the rule protects anything
      if ((live.enabled ?? false) !== spec.enabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: spec.enabled,
          actual: live.enabled ?? false,
          severity: 'critical',
        })
      }

      // simulationMode decides whether an enforcing rule actually enforces
      if ((live.simulationMode ?? false) !== spec.simulationMode) {
        diffs.push({
          field: `${spec.name}.simulationMode`,
          expected: spec.simulationMode,
          actual: live.simulationMode ?? false,
          severity: 'warning',
        })
      }

      // action is the most consequential field — what the rule does on a match
      if ((live.action ?? '').toUpperCase() !== spec.action) {
        diffs.push({
          field: `${spec.name}.action`,
          expected: spec.action,
          actual: live.action ?? 'not set',
          severity: 'critical',
        })
      }

      // conditions — diff each declared condition key against live
      const { conditions } = parseConditions(spec.conditionsRaw)
      for (const [key, value] of Object.entries(conditions)) {
        const liveValue = (live as Record<string, unknown>)[key]
        if (canonicalJson(liveValue) !== canonicalJson(value)) {
          diffs.push({
            field: `${spec.name}.conditions.${key}`,
            expected: canonicalJson(value),
            actual: liveValue === undefined ? 'not set' : canonicalJson(liveValue),
            severity: 'warning',
          })
        }
      }

      // Best-effort attribution — no-op when the rule exposes no modifier.
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
