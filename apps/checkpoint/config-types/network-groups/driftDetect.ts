import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { liveTagNames, sameStringSet } from '../lib/checkpointShared'
import { listAllGroups } from './deploy'
import { extractGroupSpecs, groupKey, liveMemberNames, type LiveGroup } from './validate'

/**
 * Detect drift between the deployed group configuration and the live
 * management database. Re-finds each declared group by name (show-groups)
 * and diffs the managed fields: a missing group is critical drift (a rule
 * referencing it would silently stop matching what the group used to cover);
 * a changed member set, comment, color or tag set is a warning. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const login = await client.login()
  if (login.error) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAllGroups(client)
    const byName = new Map<string, LiveGroup>(live.filter((g) => g.name).map((g) => [groupKey(g.name as string), g]))

    for (const spec of specs) {
      const found = byName.get(groupKey(spec.name))
      const label = spec.name

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveMembers = liveMemberNames(found.members)
      if (!sameStringSet(liveMembers, spec.members)) {
        diffs.push({
          field: `${label}.members`,
          expected: spec.members.join(', ') || '(none)',
          actual: liveMembers.join(', ') || '(none)',
          severity: 'warning',
        })
      }
      if (spec.comments || found.comments) {
        const liveComments = found.comments ?? ''
        if (liveComments !== spec.comments) {
          diffs.push({ field: `${label}.comments`, expected: spec.comments, actual: liveComments, severity: 'warning' })
        }
      }
      if (spec.color && found.color && found.color !== spec.color) {
        diffs.push({ field: `${label}.color`, expected: spec.color, actual: found.color, severity: 'warning' })
      }
      const liveTags = liveTagNames(found.tags)
      if (!sameStringSet(liveTags, spec.tags)) {
        diffs.push({
          field: `${label}.tags`,
          expected: spec.tags.join(', ') || '(none)',
          actual: liveTags.join(', ') || '(none)',
          severity: 'warning',
        })
      }
    }
  } catch {
    diffs.push({ field: 'checkpoint', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
