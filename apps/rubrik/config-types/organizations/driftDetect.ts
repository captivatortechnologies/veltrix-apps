import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, resolveServiceAccount } from '../../lib/rubrikApi'
import { organizationsFromList, findOrganizationByName, normalizeName } from './_shared'

/**
 * Drift for Organizations: an organization has only a name, so the sole
 * meaningful drift is a declared organization that no longer exists on the
 * cluster (deleted out-of-band). Best-effort — a connection failure asserts no
 * drift rather than raising a false positive. Read-only: GET /api/internal/organization.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveServiceAccount(credential)) return { hasDrift: false, diffs }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch {
    return { hasDrift: false, diffs }
  }

  let live
  try {
    live = organizationsFromList(await getJson<unknown>(conn, '/api/internal/organization'))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = normalizeName(item.fields.name)
    if (!name) continue
    const match = findOrganizationByName(live, name)
    if (!match) {
      diffs.push({ field: `${name}.exists`, expected: 'present', actual: 'missing', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
