import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOnePasswordClient } from '../../lib/onePassword'
import { listUsers } from './deploy'
import { extractUserSpecs } from './validate'

/**
 * Detect drift between the deployed user configuration and the live SCIM
 * Bridge. Re-finds each declared user by `userName` and diffs `active`,
 * `name.givenName` and `name.familyName` (only when the canvas manages that
 * field - a blank givenName/familyName is never drift-checked, mirroring
 * deploy's "blank means unmanaged" rule).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOnePasswordClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractUserSpecs(ctx.deployedConfig).filter((s) => s.userName)

  let users
  try {
    users = await listUsers(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'onepassword-scim-bridge',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  for (const spec of specs) {
    const live = users.find((u) => (u.userName ?? '').toLowerCase() === spec.userName.toLowerCase()) ?? null
    if (!live) {
      diffs.push({ field: spec.userName, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveActive = live.active !== false
    if (liveActive !== spec.active) {
      diffs.push({
        field: `${spec.userName}.active`,
        expected: String(spec.active),
        actual: String(liveActive),
        severity: 'critical',
      })
    }

    if (spec.givenName && (live.name?.givenName ?? '') !== spec.givenName) {
      diffs.push({
        field: `${spec.userName}.givenName`,
        expected: spec.givenName,
        actual: live.name?.givenName ?? '(unset)',
        severity: 'info',
      })
    }
    if (spec.familyName && (live.name?.familyName ?? '') !== spec.familyName) {
      diffs.push({
        field: `${spec.userName}.familyName`,
        expected: spec.familyName,
        actual: live.name?.familyName ?? '(unset)',
        severity: 'info',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
