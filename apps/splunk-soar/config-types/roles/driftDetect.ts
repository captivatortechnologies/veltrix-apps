import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, listAll } from '../../lib/soarApi'
import { canonicalJson } from '../../lib/soarCommon'
import { buildRoleRecord, findRoleByName, permsToMap, type SoarRole } from './_shared'

/**
 * Drift for roles: compare name, description and every permission flag
 * against the live role. Permission comparison is order-independent (SOAR's
 * `permissions` array order is not guaranteed to match ours — see
 * _shared.ts permsToMap). Best-effort: a role that can't be matched, or an
 * unreadable /rest/role collection, reports no drift rather than a false
 * positive. Read-only: GET /rest/role?page_size=0.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  let live: SoarRole[]
  try {
    live = await listAll<SoarRole>(base, headers, 'role')
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const spec = buildRoleRecord(item.fields)
    if (!spec.id || !spec.body) continue

    const match = findRoleByName(live, spec.id)
    if (!match) {
      diffs.push({ field: spec.id, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedDescription = String(spec.body.description ?? '')
    const actualDescription = String(match.description ?? '')
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${spec.id}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }

    const expectedPerms = permsToMap(spec.body.permissions)
    const actualPerms = permsToMap(match.permissions)
    if (canonicalJson(expectedPerms) !== canonicalJson(actualPerms)) {
      diffs.push({ field: `${spec.id}.permissions`, expected: expectedPerms, actual: actualPerms, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
