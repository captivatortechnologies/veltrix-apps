import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson } from '../../lib/mispApi'
import { rolesFromList, findRole, normalizeYesNo, PERM_FIELDS } from './_shared'

/**
 * Drift for roles: compare every declared permission flag against the live role
 * in MISP. Best-effort — a role that can't be matched (missing / transient
 * error) is skipped rather than raising false drift. Read-only: GET
 * /roles/index. Verify against a live MISP 2.4 instance.
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
    live = rolesFromList(await getJson<unknown>(`${base}/roles/index`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read roles, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findRole(live, name)
    if (!match) continue

    for (const perm of PERM_FIELDS) {
      const expected = normalizeYesNo(item.fields[perm])
      const actual = normalizeYesNo(match[perm])
      if (expected !== actual) {
        diffs.push({ field: `${name}.${perm}`, expected, actual, severity: 'warning' })
      }
    }

    const expectedDefaultRole = normalizeYesNo(item.fields.default_role)
    const actualDefaultRole = normalizeYesNo(match.default_role)
    if (expectedDefaultRole !== actualDefaultRole) {
      diffs.push({ field: `${name}.default_role`, expected: expectedDefaultRole, actual: actualDefaultRole, severity: 'warning' })
    }

    const expectedRestricted = normalizeYesNo(item.fields.restricted_to_site_admin)
    const actualRestricted = normalizeYesNo(match.restricted_to_site_admin)
    if (expectedRestricted !== actualRestricted) {
      diffs.push({ field: `${name}.restricted_to_site_admin`, expected: expectedRestricted, actual: actualRestricted, severity: 'warning' })
    }

    const expectedRateLimit = normalizeYesNo(item.fields.enforce_rate_limit)
    const actualRateLimit = normalizeYesNo(match.enforce_rate_limit)
    if (expectedRateLimit !== actualRateLimit) {
      diffs.push({ field: `${name}.enforce_rate_limit`, expected: expectedRateLimit, actual: actualRateLimit, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
