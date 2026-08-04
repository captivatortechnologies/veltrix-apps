import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import { extractEventOrchestrationSpecs, findOrchestration, parseOrchestrationSets } from './_shared'
import { getOrchestrationPath, listOrchestrations } from './deploy'

/**
 * Detect drift between the deployed event-orchestrations configuration and the
 * live PagerDuty account. Re-finds each declared orchestration by its `name`:
 *   - a missing orchestration is CRITICAL drift
 *   - a changed number of Router rule sets is INFO drift
 *
 * We intentionally do NOT deep-diff the sets/rules/actions JSON: PagerDuty
 * server-assigns an `id` to every rule and expands references, so a structural
 * diff against the compact JSON an operator typed would flag constant false
 * drift (the same restraint escalation-policies applies to its own rule arrays).
 * Global/Unrouted are not compared — this config type never asserts drift on a
 * path the operator didn't declare. Best-effort — an unreadable account raises no
 * false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractEventOrchestrationSpecs(ctx.deployedConfig).filter((s) => s.name && s.routerSetsJson.trim())
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await listOrchestrations(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read orchestrations, no drift asserted
  }

  for (const spec of specs) {
    const match = findOrchestration(live, spec.name)
    if (!match?.id) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedSets = parseOrchestrationSets(spec.routerSetsJson).sets
    if (!expectedSets) continue

    try {
      const router = await getOrchestrationPath(client, match.id, 'router', spec.name)
      const actualCount = Array.isArray(router?.sets) ? router.sets.length : 0
      if (expectedSets.length !== actualCount) {
        diffs.push({
          field: `${spec.name}.router_sets`,
          expected: `${expectedSets.length} set(s)`,
          actual: `${actualCount} set(s)`,
          severity: 'info',
        })
      }
    } catch {
      // best-effort: router unreadable, no drift asserted for it
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
