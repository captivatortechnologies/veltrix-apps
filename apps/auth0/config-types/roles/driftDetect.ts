import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  getJson,
} from '../../lib/auth0Api'
import { readOptionalString, readString } from '../../lib/fields'
import { findRoleByName, parsePermissions, permKey, samePermissions, type Auth0Role } from './_shared'
import { getRolePermissions } from './permissions'

/**
 * Drift for Auth0 roles: compare the description and the assigned permission grants
 * we declare against the live role in Auth0 (matched by name). The permissions
 * comparison only runs when the operator declares at least one permission, so a
 * role authored without permissions never raises drift on externally-managed grants.
 * Best-effort — an unmatched role (or a read error) is skipped. Read-only: mint
 * token → GET /roles (+ GET /roles/{id}/permissions).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let accessToken: string
  let live: Auth0Role[]
  try {
    accessToken = (await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })).accessToken
    const perPage = 100
    live = []
    for (let page = 0; page < 50; page++) {
      const batch = await getJson<Auth0Role[]>(`${base}/roles?per_page=${perPage}&page=${page}`, accessToken)
      if (!Array.isArray(batch) || batch.length === 0) break
      live.push(...batch)
      if (batch.length < perPage) break
    }
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = readString(item.fields.name)
    const match = findRoleByName(live, name)
    if (!match || !match.id) continue

    const expectedDescription = readOptionalString(item.fields.description)
    if (expectedDescription !== undefined) {
      const actualDescription = typeof match.description === 'string' ? match.description : ''
      if (expectedDescription !== actualDescription) {
        diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
      }
    }

    const desired = parsePermissions(item.fields.permissions)
    if (desired.length > 0) {
      try {
        const actual = await getRolePermissions(base, match.id, accessToken)
        if (!samePermissions(desired, actual)) {
          diffs.push({
            field: `${name}.permissions`,
            expected: desired.map(permKey).sort(),
            actual: actual.map(permKey).sort(),
            severity: 'warning',
          })
        }
      } catch {
        // best-effort: can't read this role's permissions, no drift asserted
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
