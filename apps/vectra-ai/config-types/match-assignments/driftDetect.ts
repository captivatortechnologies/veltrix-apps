import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson } from '../../lib/vectraApi'
import { assignmentsFromList, devicesForUuid, parseDeviceList } from './_shared'

/**
 * Drift for match-assignments: compare the declared device set against the live
 * assignment set, per ruleset uuid. Read-only: GET /vectra-match/assignment.
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
    live = assignmentsFromList(await getJson<unknown>(`${base}/vectra-match/assignment`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read assignments, no drift asserted
  }

  for (const item of items) {
    const uuid = String(item.fields.ruleset_uuid ?? '').trim()
    if (!uuid) continue

    const declared = [...new Set(parseDeviceList(item.fields.device_serials))].sort()
    const actual = [...devicesForUuid(live, uuid)].sort()

    if (declared.join(',') !== actual.join(',')) {
      diffs.push({ field: `${uuid}.device_serials`, expected: declared.join(', '), actual: actual.join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
