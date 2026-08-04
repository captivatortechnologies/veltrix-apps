import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, coerceList } from '../../lib/runzeroApi'
import { findGroup, readOrgRoles, orgRolesEqual, parseExpiresAt, text, type RunzeroGroup } from './_shared'

/**
 * Drift for groups: compare the description, expiry, default role and per-organization role
 * overrides we declare against the live group in runZero, matched by name. A declared group that
 * is missing entirely is critical drift. Best-effort — if the group list can't be read (transient
 * error, or an Organization key without account scope) no drift is asserted rather than raising a
 * false positive. Read-only: GET /account/groups.
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

  let live: RunzeroGroup[]
  try {
    live = coerceList<RunzeroGroup>(await getJson<unknown>(`${base}/account/groups`, headers, timeoutMs))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read groups, no drift asserted
  }

  for (const item of items) {
    const name = text(item.fields.name)
    if (!name) continue

    const match = findGroup(live, name)
    if (!match) {
      diffs.push({ field: name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedDescription = text(item.fields.description)
    const actualDescription = text(match.description)
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const expectedExpiry = parseExpiresAt(item.fields.expiresAt)
    if (expectedExpiry !== undefined && expectedExpiry !== match.expires_at) {
      diffs.push({ field: `${name}.expiresAt`, expected: String(expectedExpiry), actual: String(match.expires_at ?? ''), severity: 'info' })
    }

    const expectedDefaultRole = text(item.fields.orgDefaultRole)
    const actualDefaultRole = text(match.org_default_role)
    if (expectedDefaultRole !== actualDefaultRole) {
      diffs.push({ field: `${name}.orgDefaultRole`, expected: expectedDefaultRole, actual: actualDefaultRole, severity: 'warning' })
    }

    const expectedRoles = readOrgRoles(item.fields.orgRoles)
    const actualRoles = match.org_roles ?? {}
    if (!orgRolesEqual(expectedRoles, actualRoles)) {
      diffs.push({
        field: `${name}.orgRoles`,
        expected: JSON.stringify(expectedRoles),
        actual: JSON.stringify(actualRoles),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
