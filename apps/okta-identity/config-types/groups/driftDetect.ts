import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { attachDriftActor, veltrixActorLogins } from '../lib/oktaSystemLog'
import { findGroupByName, getCurrentMemberIds, listOktaGroups } from './deploy'
import { extractGroupSpecs } from './validate'

/**
 * Detect drift between the deployed group configuration and the live org.
 * Re-finds each declared group by profile.name and diffs the managed fields:
 *   - profile.name / profile.description (critical)
 *   - static membership — ONLY when the group opted into membership management
 *     (warning; rule-assigned members pollute the read and cannot be removed).
 *
 * Server-managed read-only fields (id, created, lastUpdated, _links, _embedded,
 * type, status) are never compared — only the fields this config type manages.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  let oktaGroups
  try {
    oktaGroups = await listOktaGroups(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'okta-org',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    const live = findGroupByName(oktaGroups, spec.name)

    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      // Deleted/absent — no live id; attribute the deletion by name (best-effort).
      await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
      continue
    }

    // profile.description — the only mutable profile field besides the name (the
    // name is the match key, so it cannot differ here).
    const liveDescription =
      typeof live.profile?.description === 'string' ? live.profile.description : ''
    if ((spec.description ?? '') !== liveDescription) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description ?? 'not set',
        actual: liveDescription || 'not set',
        severity: 'critical',
      })
    }

    // Membership drift is only meaningful when the group opted into management.
    if (spec.manageMembership && live.id) {
      try {
        const current = await getCurrentMemberIds(client, live.id)
        // null = the group could not be read (404); skip the membership-drift check
        // rather than reporting a spurious diff against an empty set.
        if (current !== null && !sameSet(spec.memberUserIds, current)) {
          diffs.push({
            field: `${spec.name}.members`,
            expected: spec.memberUserIds.slice().sort().join(', ') || 'none',
            // Rule-assigned members appear here and cannot be removed via this API.
            actual: `${current.slice().sort().join(', ') || 'none'} (rule-assigned members may be included)`,
            severity: 'warning',
          })
        }
      } catch (error) {
        diffs.push({
          field: `${spec.name}.members`,
          expected: 'readable',
          actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'warning',
        })
      }
    }

    // Attribute every diff this group produced to the last human change (once).
    await attachDriftActor(client, diffs.slice(before), {
      targetId: live.id,
      targetName: spec.name,
      excludeActorLogins,
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Order-insensitive equality of two string lists. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((item) => bSet.has(item))
}
