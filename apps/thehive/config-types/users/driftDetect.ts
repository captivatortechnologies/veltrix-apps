import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, listUsers } from '../../lib/thehiveApi'
import { buildUserUpdateBody, findUser, usersFromList, normalizeLogin, type HiveUser } from './_shared'

/**
 * Drift for users: compare the declared name / profile / organisation against
 * the live user in TheHive. Best-effort — a user that can't be matched
 * (missing / transient error) is skipped rather than raising false drift.
 * Read-only. Verify against a live TheHive (see README, v4 vs v5).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live: HiveUser[]
  try {
    live = usersFromList(await listUsers<HiveUser>(base, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read users, no drift asserted
  }

  for (const item of items) {
    const login = normalizeLogin(item.fields.login)
    if (!login) continue
    const match = findUser(live, login)
    if (!match) continue

    const desired = buildUserUpdateBody(item.fields)

    const actualName = String(match.name ?? '').trim()
    if (desired.name !== actualName) {
      diffs.push({ field: `${login}.name`, expected: desired.name, actual: actualName, severity: 'info' })
    }

    const actualProfile = String(match.profile ?? '').trim()
    if (desired.profile !== actualProfile) {
      diffs.push({ field: `${login}.profile`, expected: desired.profile, actual: actualProfile, severity: 'warning' })
    }

    // organisation is only compared when the operator pinned one (blank = inherit
    // the API key's org, which we can't assert against).
    if (desired.organisation) {
      const actualOrg = String(match.organisation ?? '').trim()
      if (desired.organisation !== actualOrg) {
        diffs.push({ field: `${login}.organisation`, expected: desired.organisation, actual: actualOrg, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
