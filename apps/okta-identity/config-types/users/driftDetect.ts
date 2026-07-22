import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { attachDriftActor, veltrixActorLogins } from '../lib/oktaSystemLog'
import { getUserByLogin } from './deploy'
import { extractUserSpecs, ACTIVE_LIKE_STATUSES, type UserSpec, type LiveUser, type UserStatus } from './validate'

/**
 * Detect drift between the deployed user configuration and the live org. For each
 * DECLARED user (found by login) it diffs only the fields this type manages —
 * the core profile attributes and the effective lifecycle status. Users not in
 * the canvas are never inspected. Server-managed fields (id, created, …) are
 * never compared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractUserSpecs(ctx.deployedConfig).filter((s) => s.login)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    let live: LiveUser | null
    try {
      live = await getUserByLogin(client, spec.login)
    } catch (error) {
      diffs.push({ field: spec.login, expected: 'reachable', actual: `unreadable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
      continue
    }

    if (!live) {
      diffs.push({ field: spec.login, expected: 'exists', actual: 'missing', severity: 'critical' })
      // Deleted/absent — no live id; attribute by login (best-effort).
      await attachDriftActor(client, diffs.slice(before), { targetName: spec.login, excludeActorLogins })
      continue
    }

    // Managed profile attributes.
    compareField(diffs, spec.login, 'email', spec.email, live.profile?.email)
    compareField(diffs, spec.login, 'firstName', spec.firstName, live.profile?.firstName)
    compareField(diffs, spec.login, 'lastName', spec.lastName, live.profile?.lastName)
    compareOptional(diffs, spec, 'displayName', live.profile?.displayName)
    compareOptional(diffs, spec, 'title', live.profile?.title)
    compareOptional(diffs, spec, 'department', live.profile?.department)
    compareOptional(diffs, spec, 'mobilePhone', live.profile?.mobilePhone)
    compareOptional(diffs, spec, 'secondEmail', live.profile?.secondEmail)

    // Effective lifecycle status (STAGED is create-only, so don't flag it).
    if (spec.status !== 'STAGED' && !statusMatches(spec.status, live.status)) {
      diffs.push({
        field: `${spec.login}.status`,
        expected: spec.status,
        actual: live.status ?? 'unknown',
        severity: 'warning',
      })
    }

    // Attribute every diff this user produced to the last human change (once).
    await attachDriftActor(client, diffs.slice(before), {
      targetId: live.id,
      targetName: spec.login,
      excludeActorLogins,
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compareField(diffs: DriftDiff[], login: string, key: string, expected: string, actual: unknown): void {
  const live = typeof actual === 'string' ? actual : ''
  if (expected !== live) {
    diffs.push({ field: `${login}.${key}`, expected: expected || 'not set', actual: live || 'not set', severity: 'warning' })
  }
}

function compareOptional(diffs: DriftDiff[], spec: UserSpec, key: keyof UserSpec, actual: unknown): void {
  const expected = (spec[key] as string | undefined) ?? ''
  const live = typeof actual === 'string' ? actual : ''
  if (expected !== live) {
    diffs.push({ field: `${spec.login}.${key}`, expected: expected || 'not set', actual: live || 'not set', severity: 'warning' })
  }
}

/** Whether a live Okta status satisfies the desired target. */
function statusMatches(desired: UserStatus, live: string | undefined): boolean {
  const s = live ?? ''
  if (desired === 'ACTIVE') return ACTIVE_LIKE_STATUSES.includes(s)
  if (desired === 'SUSPENDED') return s === 'SUSPENDED'
  if (desired === 'DEACTIVATED') return s === 'DEPROVISIONED'
  return true
}
