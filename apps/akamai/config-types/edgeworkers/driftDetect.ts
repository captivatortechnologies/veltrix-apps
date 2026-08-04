import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson } from '../../lib/akamaiApi'
import { edgeWorkersFromResponse, edgeWorkersPath, findEdgeWorker, readEdgeWorkerFields } from './_shared'

/**
 * Drift for EdgeWorkers: compare the group/resource-tier we declare against
 * the live EdgeWorker in Akamai (matched by name). Best-effort — an
 * EdgeWorker that can't be matched (missing / transient error) is skipped
 * rather than raising false drift. Read-only: GET /edgeworkers/v1/ids.
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
    const fields = readEdgeWorkerFields(item.fields)
    const match = findEdgeWorker(live, fields.name)
    if (!match) continue

    const label = fields.name

    if ((match.groupId ?? null) !== fields.groupId) {
      diffs.push({ field: `${label}.groupId`, expected: fields.groupId, actual: match.groupId, severity: 'warning' })
    }
    if ((match.resourceTierId ?? null) !== fields.resourceTierId) {
      diffs.push({ field: `${label}.resourceTierId`, expected: fields.resourceTierId, actual: match.resourceTierId, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
