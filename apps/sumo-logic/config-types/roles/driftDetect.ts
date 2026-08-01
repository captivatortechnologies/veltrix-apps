import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged } from '../../lib/sumoLogicApi'
import { findRole, toStringList, type Role } from './_shared'

/**
 * Drift for roles: compare the description, search filter and capability set we
 * declare against the live role in Sumo Logic (matched by name). Capabilities are
 * compared as an order-insensitive set. Best-effort — a role that can't be
 * matched is skipped rather than raising false drift. Read-only: GET /roles.
 *
 * API: https://www.sumologic.com/help/docs/api/role-management-v2/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let live: Role[]
  try {
    live = await listPaged<Role>(base, 'roles', headers)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read roles, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findRole(live, name)
    if (!match) continue

    const expectedDesc = String(item.fields.description ?? '').trim()
    const actualDesc = String(match.description ?? '').trim()
    if (actualDesc !== expectedDesc) {
      diffs.push({ field: `${name}.description`, expected: expectedDesc, actual: actualDesc, severity: 'warning' })
    }

    const expectedFilter = String(item.fields.filterPredicate ?? '').trim()
    const actualFilter = String(match.filterPredicate ?? '').trim()
    if (actualFilter !== expectedFilter) {
      diffs.push({ field: `${name}.filterPredicate`, expected: expectedFilter, actual: actualFilter, severity: 'warning' })
    }

    const expectedCaps = toStringList(item.fields.capabilities).slice().sort()
    const actualCaps = toStringList(match.capabilities).slice().sort()
    if (expectedCaps.join('|') !== actualCaps.join('|')) {
      diffs.push({ field: `${name}.capabilities`, expected: expectedCaps.join(', '), actual: actualCaps.join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
