import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson } from '../../lib/akamaiApi'
import {
  activationsFromResponse,
  activationsPath,
  edgeWorkersFromResponse,
  edgeWorkersPath,
  effectiveVersion,
  findEdgeWorker,
  readActivationFields,
} from './_shared'

/**
 * Drift for EdgeWorker activation: compare the declared version against
 * what's currently EFFECTIVE on the target network (matched by EdgeWorker
 * name). Best-effort — an EdgeWorker that can't be matched or whose
 * activations can't be read is skipped rather than raising false drift.
 * Read-only: GET /edgeworkers/v1/ids, GET .../{id}/activations.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.request('GET', edgeWorkersPath)
    if (!res.ok) return { hasDrift: false, diffs }
    live = edgeWorkersFromResponse(parseJson<unknown>(res.body))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const fields = readActivationFields(item.fields)
    const edgeWorker = findEdgeWorker(live, fields.edgeWorkerName)
    if (edgeWorker?.edgeWorkerId == null) continue

    const label = `${fields.edgeWorkerName} → ${fields.network}`

    try {
      const res = await client.request('GET', activationsPath(edgeWorker.edgeWorkerId))
      if (!res.ok) continue
      const activations = activationsFromResponse(parseJson<unknown>(res.body))
      const effective = effectiveVersion(activations, fields.network)
      if (effective !== fields.version) {
        diffs.push({ field: label, expected: `v${fields.version}`, actual: effective == null ? 'never activated' : `v${effective}`, severity: 'warning' })
      }
    } catch {
      continue
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
