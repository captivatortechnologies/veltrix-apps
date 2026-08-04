import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { addOneToOneRule, applyOneToOneNat, deleteOneToOneRule, searchOneToOneRules, setOneToOneRule, type LiveOneToOneRule } from '../../lib/oneToOneNatApi'
import { buildOpnsenseClient, searchCategories, type LiveCategory } from '../../lib/opnsenseApi'
import { buildOneToOneRuleBody, extractOneToOneRuleSpecs, snapshotLive, type OneToOneRuleSpec } from './_shared'
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

function resolveCategoryUuids(names: string[], byName: Map<string, LiveCategory>): string[] {
  return names.map((name) => {
    const found = byName.get(name)
    if (!found) {
      throw new Error(`Unknown category "${name}" — declare it in a firewall-categories canvas and deploy that first`)
    }
    return found.uuid
  })
}

/**
 * Deploy OPNsense 1:1 NAT rules via /api/firewall/one_to_one (REQUIRES
 * OPNsense 24.1.9+ — see lib/oneToOneNatApi.ts's module doc).
 *
 * Identity is the CANVAS ITEM's own stable id — `onetoone.rule` has no name
 * field. Every tracked rule was created BY THIS APP, so a tracked itemId no
 * longer declared is always removed (delRule), exactly like firewall-rules/
 * source-nat. Stage (addRule/setRule/delRule) then apply ONCE
 * (`/api/firewall/one_to_one/apply`).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const specs: OneToOneRuleSpec[] = extractOneToOneRuleSpecs(ctx.canvas)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const [liveRules, liveCategories] = await Promise.all([searchOneToOneRules(client), searchCategories(client)])
    const categoryByName = new Map<string, LiveCategory>(liveCategories.filter((c) => c.name).map((c) => [c.name as string, c]))
    const liveByUuid = new Map<string, LiveOneToOneRule>(liveRules.map((r) => [r.uuid, r]))
    const prior = await loadPriorEntries(ctx)
    const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

    for (const spec of specs) {
      const categoryUuids = resolveCategoryUuids(spec.categories, categoryByName)
      const body = buildOneToOneRuleBody(spec, categoryUuids)

      const priorEntry = priorByItemId.get(spec.itemId)
      const existingLive = priorEntry?.uuid ? liveByUuid.get(priorEntry.uuid) : undefined

      if (existingLive) {
        await setOneToOneRule(client, existingLive.uuid, body)
        entries.push({ itemId: spec.itemId, description: spec.description, existed: true, uuid: existingLive.uuid, prior: snapshotLive(existingLive) })
        updated++
      } else {
        const uuid = await addOneToOneRule(client, body)
        entries.push({ itemId: spec.itemId, description: spec.description, existed: false, uuid })
        created++
      }
    }

    const declaredItemIds = new Set(specs.map((s) => s.itemId))
    for (const p of prior) {
      if (declaredItemIds.has(p.itemId) || !p.uuid) continue
      const stillLive = liveByUuid.get(p.uuid)
      if (!stillLive) continue
      await deleteOneToOneRule(client, p.uuid)
      deleted++
    }

    const touched = created + updated + deleted
    const applyNote = touched > 0 ? `applied (${await applyOneToOneNat(client)})` : 'nothing to apply'

    return {
      success: true,
      message: `Reconciled ${specs.length} OPNsense 1:1 NAT rule(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed — ${applyNote}.`,
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
