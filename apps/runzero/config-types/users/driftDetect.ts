import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, coerceList } from '../../lib/runzeroApi'
import { findUser, readOrgRoles, orgRolesEqual, text, type RunzeroUser } from './_shared'

/**
 * Drift for users: compare the name, client-admin flag, default role and per-organization role
 * overrides we declare against the live user in runZero, matched by email. A declared user that is
 * missing entirely is critical drift. Best-effort — if the user list can't be read (transient
 * error, or an Organization key without account scope) no drift is asserted rather than raising a
 * false positive. Read-only: GET /account/users.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveRunzeroToken(credential)) return { hasDrift: false, diffs }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const rawTimeout = settings?.request_timeout_seconds
  const timeoutMs = typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout * 1000 : undefined

  let live: RunzeroUser[]
  try {
    live = coerceList<RunzeroUser>(await getJson<unknown>(`${base}/account/users`, headers, timeoutMs))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read users, no drift asserted
  }

  for (const item of items) {
    const email = text(item.fields.email)
    if (!email) continue

    const match = findUser(live, email)
    if (!match) {
      diffs.push({ field: email, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedFirst = text(item.fields.firstName)
    const actualFirst = text(match.first_name)
    if (expectedFirst !== actualFirst) {
      diffs.push({ field: `${email}.firstName`, expected: expectedFirst, actual: actualFirst, severity: 'info' })
    }

    const expectedLast = text(item.fields.lastName)
    const actualLast = text(match.last_name)
    if (expectedLast !== actualLast) {
      diffs.push({ field: `${email}.lastName`, expected: expectedLast, actual: actualLast, severity: 'info' })
    }

    const expectedAdmin = item.fields.clientAdmin === true
    const actualAdmin = match.client_admin === true
    if (expectedAdmin !== actualAdmin) {
      diffs.push({
        field: `${email}.clientAdmin`,
        expected: String(expectedAdmin),
        actual: String(actualAdmin),
        severity: expectedAdmin !== actualAdmin && actualAdmin ? 'critical' : 'warning',
      })
    }

    const expectedDefaultRole = text(item.fields.orgDefaultRole)
    const actualDefaultRole = text(match.org_default_role)
    if (expectedDefaultRole !== actualDefaultRole) {
      diffs.push({ field: `${email}.orgDefaultRole`, expected: expectedDefaultRole, actual: actualDefaultRole, severity: 'warning' })
    }

    const expectedRoles = readOrgRoles(item.fields.orgRoles)
    const actualRoles = match.org_roles ?? {}
    if (!orgRolesEqual(expectedRoles, actualRoles)) {
      diffs.push({
        field: `${email}.orgRoles`,
        expected: JSON.stringify(expectedRoles),
        actual: JSON.stringify(actualRoles),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
