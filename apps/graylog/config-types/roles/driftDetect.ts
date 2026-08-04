import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { rolesFromList, findRole, parsePermissions } from './_shared'

/**
 * Drift for roles: compare the description and the (order-insensitive)
 * permission set we declare against the live role in Graylog. Best-effort — a
 * role that can't be matched is skipped rather than raising false drift.
 * Read-only: GET /api/roles.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = rolesFromList(await getJson<unknown>(`${base}/api/roles`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = asString(item.fields.name)
    const match = findRole(live, name)
    if (!match) continue

    const expectedDescription = asString(item.fields.description)
    const actualDescription = asString(match.description)
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const { permissions: expectedPermissions } = parsePermissions(item.fields.permissions)
    const actualPermissions = Array.isArray(match.permissions) ? match.permissions : []
    const expectedSorted = [...expectedPermissions].sort().join(',')
    const actualSorted = [...actualPermissions].sort().join(',')
    if (expectedSorted !== actualSorted) {
      diffs.push({ field: `${name}.permissions`, expected: expectedSorted || '(none)', actual: actualSorted || '(none)', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
