import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import { extractTeamSpecs, findTeam } from './_shared'
import { listTeams } from './deploy'

/**
 * Detect drift between the deployed teams configuration and the live PagerDuty
 * account. Re-finds each declared team by its `name`:
 *   - a missing team is CRITICAL drift
 *   - a changed description is INFO drift (only when the operator authored one)
 *
 * Best-effort — an unreadable account raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractTeamSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await listTeams(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read teams, no drift asserted
  }

  for (const spec of specs) {
    const match = findTeam(live, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (spec.description && String(match.description ?? '') !== spec.description) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description,
        actual: String(match.description ?? ''),
        severity: 'info',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
