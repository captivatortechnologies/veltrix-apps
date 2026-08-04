import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson } from '../../lib/mispApi'
import { usersFromList, findUser, normalizeYesNo } from './_shared'

/**
 * Drift for users: compare the declared organisation, role and account-state
 * flags against the live user in MISP. Best-effort — a user that can't be
 * matched (missing / transient error) is skipped rather than raising false
 * drift. Read-only: GET /admin/users/index. Verify against a live MISP 2.4 instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = usersFromList(await getJson<unknown>(`${base}/admin/users/index`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read users, no drift asserted
  }

  for (const item of items) {
    const email = String(item.fields.email ?? '').trim()
    const match = findUser(live, email)
    if (!match) continue

    const expectedOrgId = Number(item.fields.org_id ?? 0)
    const actualOrgId = Number(match.org_id ?? 0)
    if (expectedOrgId !== actualOrgId) {
      diffs.push({ field: `${email}.org_id`, expected: expectedOrgId, actual: actualOrgId, severity: 'warning' })
    }

    const expectedRoleId = Number(item.fields.role_id ?? 0)
    const actualRoleId = Number(match.role_id ?? 0)
    if (expectedRoleId !== actualRoleId) {
      diffs.push({ field: `${email}.role_id`, expected: expectedRoleId, actual: actualRoleId, severity: 'warning' })
    }

    const expectedDisabled = normalizeYesNo(item.fields.disabled)
    const actualDisabled = normalizeYesNo(match.disabled)
    if (expectedDisabled !== actualDisabled) {
      diffs.push({ field: `${email}.disabled`, expected: expectedDisabled, actual: actualDisabled, severity: 'warning' })
    }

    const expectedExternalAuth = normalizeYesNo(item.fields.external_auth_required)
    const actualExternalAuth = normalizeYesNo(match.external_auth_required)
    if (expectedExternalAuth !== actualExternalAuth) {
      diffs.push({ field: `${email}.external_auth_required`, expected: expectedExternalAuth, actual: actualExternalAuth, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
