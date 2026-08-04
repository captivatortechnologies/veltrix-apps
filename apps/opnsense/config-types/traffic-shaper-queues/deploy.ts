import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { addQueue, deleteQueue, reconfigureTrafficShaper, searchPipes, searchQueues, setQueue, type LivePipe, type LiveQueue } from '../../lib/trafficShaperApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { buildQueueBody, extractQueueSpecs, queueKey, snapshotLive, type QueueSpec } from './_shared'
import type { RollbackEntry } from './rollback'

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Deploy OPNsense traffic-shaper queues via /api/trafficshaper/settings.
 * Identity is `description`. `pipe` is resolved from the declared pipe
 * NAME to its live uuid (fails the whole deploy if unresolvable, before
 * staging anything). Stage (addQueue/setQueue/delQueue) then apply ONCE.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const specs: QueueSpec[] = extractQueueSpecs(ctx.canvas).filter((s) => s.description)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const [live, livePipes] = await Promise.all([searchQueues(client), searchPipes(client)])
    const pipeByName = new Map<string, LivePipe>(livePipes.filter((p) => p.description).map((p) => [p.description as string, p]))
    const liveByKey = new Map<string, LiveQueue>(live.filter((q) => q.description).map((q) => [queueKey(q.description as string), q]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const pipe = pipeByName.get(spec.pipeName)
      if (!pipe) throw new Error(`Unknown pipe "${spec.pipeName}" — declare it in a traffic-shaper-pipes canvas and deploy that first`)

      const key = queueKey(spec.description)
      const match = liveByKey.get(key) ?? null
      const body = buildQueueBody(spec, pipe.uuid)

      if (match) {
        await setQueue(client, match.uuid, body)
        entries.push({ itemId: spec.itemId, key, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const uuid = await addQueue(client, body)
        entries.push({ itemId: spec.itemId, key, existed: false, uuid })
        created++
      }
    }

    const declaredKeys = new Set(specs.map((s) => queueKey(s.description)))
    for (const p of prior) {
      if (p.existed || declaredKeys.has(p.key)) continue
      const stillLive = liveByKey.get(p.key)
      if (!stillLive) continue
      await deleteQueue(client, stillLive.uuid)
      deleted++
    }

    const touched = created + updated + deleted
    if (touched > 0) {
      await reconfigureTrafficShaper(client)
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} OPNsense traffic-shaper queue(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed${
        touched > 0 ? ' (applied)' : ' (nothing to apply)'
      }.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { entries },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deploy failed after ${created} created, ${updated} updated, ${deleted} removed (staged, not necessarily applied): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { entries },
    }
  }
}
