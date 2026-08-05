import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { attachDriftActor, veltrixActorLogins } from '../lib/qualysActivityLog'
import { listUsers } from './deploy'
import { extractUserSpecs, userKey, type LiveUser } from './validate'

/**
 * Detect drift between the deployed user accounts and the live platform.
 * Re-finds each declared user by email and diffs the fields the account list
 * exposes in a comparable form (first name, last name, job title); a missing
 * user is critical drift. Role/business unit/asset groups are not diffed — this
 * app's list parsing does not confidently resolve those fields (see deploy.ts).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractUserSpecs(ctx.deployedConfig).filter((s) => s.email)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listUsers(client)
    const byKey = new Map<string, LiveUser>(live.map((u) => [userKey(u), u]))

    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(userKey(spec))
      if (!found) {
        diffs.push({ field: spec.email, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.email, excludeActorLogins })
        continue
      }
      if (found.firstName && found.firstName !== spec.firstName) {
        diffs.push({
          field: `${spec.email}.first_name`,
          expected: spec.firstName,
          actual: found.firstName,
          severity: 'info',
        })
      }
      if (found.lastName && found.lastName !== spec.lastName) {
        diffs.push({
          field: `${spec.email}.last_name`,
          expected: spec.lastName,
          actual: found.lastName,
          severity: 'info',
        })
      }
      if (found.jobTitle && found.jobTitle !== spec.jobTitle) {
        diffs.push({
          field: `${spec.email}.job_title`,
          expected: spec.jobTitle,
          actual: found.jobTitle,
          severity: 'info',
        })
      }

      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id || found.login,
        targetName: spec.email,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'qualys',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
