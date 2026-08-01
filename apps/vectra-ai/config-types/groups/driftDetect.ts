import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson } from '../../lib/vectraApi'
import { groupsFromList, findGroup, normalizeMembers } from './_shared'

/**
 * Drift for groups: compare the description, type and membership we declare against
 * the live group in Vectra, matched by name. Best-effort — a group that can't be
 * matched (missing / transient error) is skipped rather than raising false drift.
 * Read-only: GET /groups. Verify against a live Vectra brain.
 *
 * NOTE: a type diff is reported but a group's type cannot be changed in place (the
 * v2 update path omits it) — correcting it means recreating the group. Members are
 * compared as normalized sets since Vectra may return them expanded.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = groupsFromList(await getJson<unknown>(`${base}/groups?page_size=5000`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read groups, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findGroup(live, name)
    if (!match) continue

    const type = String(item.fields.type ?? '').trim()

    const expectedDescription = String(item.fields.description ?? '').trim()
    const actualDescription = String(match.description ?? '').trim()
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }

    const actualType = String(match.type ?? '').trim()
    if (type && actualType && type !== actualType) {
      diffs.push({ field: `${name}.type`, expected: type, actual: actualType, severity: 'warning' })
    }

    const expectedMembers = normalizeMembers(item.fields.members, type).map(String).sort()
    const actualMembers = normalizeMembers(match.members, actualType || type).map(String).sort()
    if (expectedMembers.join(',') !== actualMembers.join(',')) {
      diffs.push({ field: `${name}.members`, expected: expectedMembers.join(', '), actual: actualMembers.join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
