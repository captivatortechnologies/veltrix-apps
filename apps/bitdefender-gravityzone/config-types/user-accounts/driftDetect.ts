import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import {
  accountEmail,
  accountFieldsMatch,
  extractUserAccountSpecs,
  listAllAccounts,
  parseRights,
  resolveAccountRights,
  userAccountKey,
} from './_shared'

/**
 * Detect drift for user accounts: for each declared email, find the live
 * account and compare fullName/role/timezone/language/targetIds/rights. A
 * declared email that no longer exists is critical drift; a changed
 * comparable field is a warning. Password is write-only and excluded from
 * comparison — see _shared.ts and README.md "Known limitations".
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractUserAccountSpecs(ctx.deployedConfig).filter((s) => s.email)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live
  try {
    live = await listAllAccounts(client)
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const liveByEmail = new Map(live.filter((a) => accountEmail(a)).map((a) => [userAccountKey(accountEmail(a)), a]))

  for (const spec of specs) {
    const match = liveByEmail.get(userAccountKey(spec.email))
    if (!match) {
      diffs.push({ field: spec.email, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveRights = await resolveAccountRights(client, match)
    if (!accountFieldsMatch(spec, match, liveRights)) {
      const { value: declaredRights } = parseRights(spec)
      const liveTargetIds = Array.isArray(match.targetIds) ? match.targetIds.map(String) : []
      diffs.push({
        field: `${spec.email}.profile`,
        expected: { fullName: spec.fullName, role: spec.role || undefined, timezone: spec.timezone, language: spec.language, targetIds: spec.targetIds, rights: declaredRights ?? {} },
        actual: {
          fullName: match.profile?.fullName ?? match.fullName ?? '',
          role: typeof match.role === 'number' ? match.role : undefined,
          timezone: match.profile?.timezone ?? '',
          language: match.profile?.language ?? '',
          targetIds: liveTargetIds,
          rights: liveRights ?? {},
        },
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
