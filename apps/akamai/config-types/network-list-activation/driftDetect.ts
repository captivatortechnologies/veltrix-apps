import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, NETWORK_LISTS_PATH, parseJson } from '../../lib/akamaiApi'
import { findList, listsFromResponse, readActivationFields, readStatusOrNull } from './_shared'

/**
 * Drift for an activation target: the declared intent is "this list is ACTIVE at
 * its latest syncPoint on {network}". Drift = that is no longer true —
 *   - status is not ACTIVE (INACTIVE / MODIFIED / FAILED), or
 *   - the activated syncPoint lags the list's current syncPoint (unactivated
 *     edits exist — Akamai's MODIFIED state).
 * Read-only:
 *   GET /network-list/v2/network-lists                                (resolve id + syncPoint)
 *   GET /network-list/v2/network-lists/{id}/environments/{env}/status (activated version)
 * Best-effort — a list/status that can't be read is skipped, not flagged.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.request('GET', NETWORK_LISTS_PATH, { query: { includeElements: false } })
    if (!res.ok) return { hasDrift: false, diffs }
    live = listsFromResponse(parseJson<unknown>(res.body))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const fields = readActivationFields(item.fields)
    const list = findList(live, fields.networkListName)
    if (!list || !list.uniqueId) continue

    const targetSyncPoint = list.syncPoint ?? 0
    const status = await readStatusOrNull(client, list.uniqueId, fields.network)
    const label = `${fields.networkListName} → ${fields.network}`

    const state = status?.activationStatus ?? 'INACTIVE'
    const activeSyncPoint = status?.syncPoint ?? -1

    if (state !== 'ACTIVE') {
      diffs.push({ field: `${label}.activationStatus`, expected: 'ACTIVE', actual: state, severity: 'warning' })
    } else if (activeSyncPoint < targetSyncPoint) {
      diffs.push({
        field: `${label}.syncPoint`,
        expected: `active at syncPoint ${targetSyncPoint}`,
        actual: `active at syncPoint ${activeSyncPoint} (unactivated edits pending)`,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
