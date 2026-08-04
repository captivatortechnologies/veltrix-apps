import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import { extractUserSpecs, findUser } from './_shared'
import { listUsers } from './deploy'

/**
 * Detect drift between the deployed users configuration and the live PagerDuty
 * account. Re-finds each declared user by their `email`:
 *   - a missing user is CRITICAL drift
 *   - a changed role, time_zone or job_title (only when the operator declared
 *     one) is WARNING drift
 *
 * We intentionally do NOT deep-diff color or description — low-value fields
 * that don't affect on-call behavior, kept lean to match this app's restraint
 * elsewhere. Best-effort — an unreadable account raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractUserSpecs(ctx.deployedConfig).filter((s) => s.name && s.email)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await listUsers(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read users, no drift asserted
  }

  for (const spec of specs) {
    const match = findUser(live, spec.email)
    if (!match) {
      diffs.push({ field: spec.email, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (spec.role && String(match.role ?? '') !== spec.role) {
      diffs.push({ field: `${spec.email}.role`, expected: spec.role, actual: String(match.role ?? ''), severity: 'warning' })
    }

    if (spec.timeZone && String(match.time_zone ?? '') !== spec.timeZone) {
      diffs.push({
        field: `${spec.email}.time_zone`,
        expected: spec.timeZone,
        actual: String(match.time_zone ?? ''),
        severity: 'warning',
      })
    }

    if (spec.jobTitle && String(match.job_title ?? '') !== spec.jobTitle) {
      diffs.push({
        field: `${spec.email}.job_title`,
        expected: spec.jobTitle,
        actual: String(match.job_title ?? ''),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
