import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson } from '../../lib/mispApi'
import { sharingGroupsFromList, findSharingGroup, normalizeYesNo } from './_shared'

/**
 * Drift for sharing groups: compare the releasability and description we declare
 * against the live sharing group in MISP. Best-effort — a group that can't be
 * matched (missing / transient error) is skipped rather than raising false drift.
 * Read-only: GET /sharing_groups. Verify against a live MISP 2.4 instance.
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
    live = sharingGroupsFromList(await getJson<unknown>(`${base}/sharing_groups`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read sharing groups, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findSharingGroup(live, name)
    if (!match) continue

    const expectedReleasable = normalizeYesNo(item.fields.releasable)
    const actualReleasable = normalizeYesNo(match.releasability)
    if (actualReleasable !== expectedReleasable) {
      diffs.push({ field: `${name}.releasable`, expected: expectedReleasable, actual: actualReleasable, severity: 'warning' })
    }

    const expectedDescription = String(item.fields.description ?? '').trim()
    const actualDescription = String(match.description ?? '').trim()
    if (expectedDescription && actualDescription !== expectedDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
