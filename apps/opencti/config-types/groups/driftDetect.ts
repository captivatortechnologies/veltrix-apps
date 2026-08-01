import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_GROUPS_QUERY, findGroup, groupsFromList, normalizeBool, normalizeText } from './_shared'

/**
 * Drift for groups: compare the description and the two boolean toggles we declare
 * against the live group in OpenCTI (matched by name). Best-effort — a group that
 * can't be matched (missing / transient error) is skipped rather than raising false
 * drift. Read-only: groups. Verify against a live OpenCTI instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = groupsFromList(await graphql<unknown>(base, headers, LIST_GROUPS_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read groups, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findGroup(live, name)
    if (!match) continue

    const expectedDescription = normalizeText(item.fields.description)
    const actualDescription = normalizeText(match.description)
    if (expectedDescription !== undefined && actualDescription !== undefined && expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const expectedDefault = normalizeBool(item.fields.default_assignation)
    const actualDefault = normalizeBool(match.default_assignation)
    if (expectedDefault !== undefined && actualDefault !== undefined && expectedDefault !== actualDefault) {
      diffs.push({ field: `${name}.default_assignation`, expected: expectedDefault, actual: actualDefault, severity: 'warning' })
    }

    const expectedAuto = normalizeBool(item.fields.auto_new_marking)
    const actualAuto = normalizeBool(match.auto_new_marking)
    if (expectedAuto !== undefined && actualAuto !== undefined && expectedAuto !== actualAuto) {
      diffs.push({ field: `${name}.auto_new_marking`, expected: expectedAuto, actual: actualAuto, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
