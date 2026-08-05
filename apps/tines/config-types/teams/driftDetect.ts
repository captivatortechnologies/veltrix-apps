import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTinesClient } from '../../lib/tinesApi'
import { extractTeamSpecs, findTeam } from './_shared'
import { listTeams } from './deploy'

/**
 * Detect drift between the deployed teams configuration and the live Tines
 * tenant. Re-finds each declared team by its `name`: a missing team is
 * CRITICAL drift. Best-effort — an unreadable tenant raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
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
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
