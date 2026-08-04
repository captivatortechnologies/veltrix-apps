import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, normalizeBool } from '../../lib/secretServerApi'
import { extractUserSpecs, searchUsers, findUserByUsername, isDirectoryUser } from './_shared'

/**
 * Drift for users: for each declared user, re-find it by username and compare
 * the managed profile attributes. A user that can't be found is critical
 * drift; a directory-managed user is skipped (its profile is not owned here,
 * mirroring deploy). Best-effort — a read error asserts no drift rather than
 * raising a false critical. Read-only: GET /api/v1/users.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const specs = extractUserSpecs(items).filter((s) => s.username)
  if (specs.length === 0) return { hasDrift: false, diffs }

  try {
    for (const spec of specs) {
      const matches = await searchUsers(client, spec.username)
      const match = findUserByUsername(matches, spec.username)
      if (!match) {
        diffs.push({ field: spec.username, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if (isDirectoryUser(match)) continue

      const checks: Array<[string, unknown, unknown]> = [
        ['displayName', spec.displayName, match.displayName],
        ['emailAddress', spec.emailAddress, match.emailAddress],
        ['enabled', spec.enabled, match.enabled !== undefined ? normalizeBool(match.enabled) : undefined],
        ['isApplicationAccount', spec.isApplicationAccount, match.isApplicationAccount !== undefined ? normalizeBool(match.isApplicationAccount) : undefined],
      ]
      for (const [field, expected, actual] of checks) {
        if (actual !== undefined && expected !== actual) {
          diffs.push({ field: `${spec.username}.${field}`, expected, actual, severity: 'warning' })
        }
      }
    }
  } catch {
    return { hasDrift: false, diffs } // best-effort: unreadable → no drift asserted
  }

  return { hasDrift: diffs.length > 0, diffs }
}
