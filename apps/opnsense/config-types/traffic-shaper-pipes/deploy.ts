import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { addPipe, deletePipe, reconfigureTrafficShaper, searchPipes, setPipe, type LivePipe } from '../../lib/trafficShaperApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { buildPipeBody, extractPipeSpecs, pipeKey, snapshotLive, type PipeSpec } from './_shared'
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
 * Deploy OPNsense traffic-shaper pipes via /api/trafficshaper/settings.
 * Identity is `description` (required by the model, see _shared.ts).
 * `number` (the pf dnpipe id) is never sent — the server assigns it on
 * create and this app never touches it on update. Stage
 * (addPipe/setPipe/delPipe) then apply ONCE
 * (`/api/trafficshaper/service/reconfigure`, reloads shaper + ipfw).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const specs: PipeSpec[] = extractPipeSpecs(ctx.canvas).filter((s) => s.description)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await searchPipes(client)
    const liveByKey = new Map<string, LivePipe>(live.filter((p) => p.description).map((p) => [pipeKey(p.description as string), p]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const key = pipeKey(spec.description)
      const match = liveByKey.get(key) ?? null
      const body = buildPipeBody(spec)

      if (match) {
        await setPipe(client, match.uuid, body)
        entries.push({ itemId: spec.itemId, key, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const uuid = await addPipe(client, body)
        entries.push({ itemId: spec.itemId, key, existed: false, uuid })
        created++
      }
    }

    const declaredKeys = new Set(specs.map((s) => pipeKey(s.description)))
    for (const p of prior) {
      if (p.existed || declaredKeys.has(p.key)) continue
      const stillLive = liveByKey.get(p.key)
      if (!stillLive) continue
      await deletePipe(client, stillLive.uuid)
      deleted++
    }

    const touched = created + updated + deleted
    if (touched > 0) {
      await reconfigureTrafficShaper(client)
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} OPNsense traffic-shaper pipe(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed${
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
