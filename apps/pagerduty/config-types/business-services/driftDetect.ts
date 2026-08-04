import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import { extractBusinessServiceSpecs, findBusinessService } from './_shared'
import { listBusinessServices } from './deploy'

/**
 * Detect drift between the deployed business services configuration and the live
 * PagerDuty account. Re-finds each declared item by its `name`:
 *   - a missing business service is CRITICAL drift
 *   - a changed description is WARNING drift (only when the operator authored one)
 *   - a changed point_of_contact is WARNING drift (only when the operator authored one)
 *
 * `team` is intentionally never diffed: the API returns a fully-expanded team
 * reference (id/type/self) that can't be compared against the operator's plain
 * team name without another lookup — the same reasoning escalation-policies uses
 * to avoid deep-diffing expanded references. Best-effort — an unreadable account
 * raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractBusinessServiceSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await listBusinessServices(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read business services, no drift asserted
  }

  for (const spec of specs) {
    const match = findBusinessService(live, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (spec.description && String(match.description ?? '') !== spec.description) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description,
        actual: String(match.description ?? ''),
        severity: 'warning',
      })
    }

    if (spec.pointOfContact && String(match.point_of_contact ?? '') !== spec.pointOfContact) {
      diffs.push({
        field: `${spec.name}.point_of_contact`,
        expected: spec.pointOfContact,
        actual: String(match.point_of_contact ?? ''),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
