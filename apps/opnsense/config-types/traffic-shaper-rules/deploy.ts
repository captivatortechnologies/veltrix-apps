import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  addShaperRule,
  deleteShaperRule,
  reconfigureTrafficShaper,
  searchPipes,
  searchQueues,
  searchShaperRules,
  setShaperRule,
  type LiveShaperRule,
} from '../../lib/trafficShaperApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { buildShaperRuleBody, extractShaperRuleSpecs, snapshotLive, type ShaperRuleSpec } from './_shared'
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
 * Deploy OPNsense traffic-shaper rules via /api/trafficshaper/settings.
 * Identity is the CANVAS ITEM's own stable id (shaper rules have no
 * required name field). `target` is resolved by NAME against EITHER a
 * traffic-shaper-pipes OR a traffic-shaper-queues item's description (both
 * searched; a name found in either resolves) — fails the whole deploy if
 * unresolvable. Stage (addRule/setRule/delRule) then apply ONCE.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const specs: ShaperRuleSpec[] = extractShaperRuleSpecs(ctx.canvas)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const [liveRules, livePipes, liveQueues] = await Promise.all([searchShaperRules(client), searchPipes(client), searchQueues(client)])
    const targetByName = new Map<string, string>()
    for (const p of livePipes) if (p.description) targetByName.set(p.description as string, p.uuid)
    for (const q of liveQueues) if (q.description) targetByName.set(q.description as string, q.uuid)
    const liveByUuid = new Map<string, LiveShaperRule>(liveRules.map((r) => [r.uuid, r]))
    const prior = await loadPriorEntries(ctx)
    const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

    for (const spec of specs) {
      const targetUuid = targetByName.get(spec.targetName)
      if (!targetUuid) {
        throw new Error(`Unknown pipe/queue target "${spec.targetName}" — declare it in a traffic-shaper-pipes or traffic-shaper-queues canvas and deploy that first`)
      }
      const body = buildShaperRuleBody(spec, targetUuid)

      const priorEntry = priorByItemId.get(spec.itemId)
      const existingLive = priorEntry?.uuid ? liveByUuid.get(priorEntry.uuid) : undefined

      if (existingLive) {
        await setShaperRule(client, existingLive.uuid, body)
        entries.push({ itemId: spec.itemId, description: spec.description, existed: true, uuid: existingLive.uuid, prior: snapshotLive(existingLive) })
        updated++
      } else {
        const uuid = await addShaperRule(client, body)
        entries.push({ itemId: spec.itemId, description: spec.description, existed: false, uuid })
        created++
      }
    }

    const declaredItemIds = new Set(specs.map((s) => s.itemId))
    for (const p of prior) {
      if (declaredItemIds.has(p.itemId) || !p.uuid) continue
      const stillLive = liveByUuid.get(p.uuid)
      if (!stillLive) continue
      await deleteShaperRule(client, p.uuid)
      deleted++
    }

    const touched = created + updated + deleted
    if (touched > 0) {
      await reconfigureTrafficShaper(client)
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} OPNsense traffic-shaper rule(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed${
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
