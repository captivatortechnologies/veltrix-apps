import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTinesClient } from '../../lib/tinesApi'
import { extractTeamMemberSpecs, findMember } from './_shared'
import { listMembers } from './deploy'

/**
 * Detect drift between the deployed Team Members configuration and the live
 * Tines tenant. Re-finds each declared (team, email):
 *   - a missing member is CRITICAL drift
 *   - a role that no longer matches is WARNING drift — Tines has no
 *     update-role API, so this is surfaced rather than auto-corrected
 * Best-effort — an unreadable team raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractTeamMemberSpecs(ctx.deployedConfig).filter((s) => s.teamId && s.email)
  if (specs.length === 0) return { hasDrift: false, diffs }

  const cache = new Map<string, Awaited<ReturnType<typeof listMembers>>>()
  for (const spec of specs) {
    let members = cache.get(spec.teamId)
    if (!members) {
      try {
        members = await listMembers(client, spec.teamId)
        cache.set(spec.teamId, members)
      } catch {
        continue
      }
    }

    const match = findMember(members, spec.email)
    if (!match) {
      diffs.push({ field: spec.email, expected: 'member of team', actual: 'not a member', severity: 'critical' })
      continue
    }
    if (spec.role && match.role && match.role !== spec.role) {
      diffs.push({ field: `${spec.email}.role`, expected: spec.role, actual: match.role, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
