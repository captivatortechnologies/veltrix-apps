import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  addFilterRule,
  applyFilterModule,
  buildOpnsenseClient,
  deleteFilterRule,
  FILTER_MODULE,
  searchCategories,
  searchFilterRules,
  setFilterRule,
  type LiveCategory,
  type LiveFilterRule,
} from '../../lib/opnsenseApi'
import { buildFilterRuleBody, extractFilterRuleSpecs, snapshotLive, type FilterRuleSpec } from './_shared'
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

/** Resolve declared category NAMES to their live uuids. Throws naming the first unresolvable one. */
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
 * Deploy OPNsense firewall rules via /api/firewall/filter (REQUIRES OPNsense
 * 24.1+ — see lib/opnsenseApi.ts's FILTER_MODULE doc for the version-floor
 * citation).
 *
 * Identity is the CANVAS ITEM's own stable id (see _shared.ts's module doc —
 * pf rules have no name field to reconcile by), mapped to the OPNsense
 * `uuid` addRule assigns and persisted in rollbackData. A declared rule whose
 * itemId matches a prior deploy's entry is updated (setRule); a new itemId is
 * created (addRule). Every tracked rule was created BY THIS APP (there is no
 * "pre-existing, not ours" case the way there is for name-matched aliases),
 * so a tracked itemId no longer declared is always removed (delRule).
 *
 * Categories are referenced by NAME in the canvas and resolved to their live
 * uuid here — an unresolvable name fails the whole deploy before anything is
 * staged (fail fast, not partially).
 *
 * Exactly like firewall-aliases: every addRule/setRule/delRule call only
 * STAGES a change. `apply` (`/api/firewall/filter/apply`) runs once, after
 * every stage call, to actually reload the pf ruleset.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const specs: FilterRuleSpec[] = extractFilterRuleSpecs(ctx.canvas)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const [liveRules, liveCategories] = await Promise.all([searchFilterRules(client), searchCategories(client)])
    const categoryByName = new Map<string, LiveCategory>(liveCategories.filter((c) => c.name).map((c) => [c.name as string, c]))
    const liveByUuid = new Map<string, LiveFilterRule>(liveRules.map((r) => [r.uuid, r]))
    const prior = await loadPriorEntries(ctx)
    const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

    for (const spec of specs) {
      const categoryUuids = resolveCategoryUuids(spec.categories, categoryByName)
      const body = buildFilterRuleBody(spec, categoryUuids)

      const priorEntry = priorByItemId.get(spec.itemId)
      const existingLive = priorEntry?.uuid ? liveByUuid.get(priorEntry.uuid) : undefined

      if (existingLive) {
        await setFilterRule(client, existingLive.uuid, body)
        entries.push({ itemId: spec.itemId, description: spec.description, existed: true, uuid: existingLive.uuid, prior: snapshotLive(existingLive) })
        updated++
      } else {
        const uuid = await addFilterRule(client, body)
        entries.push({ itemId: spec.itemId, description: spec.description, existed: false, uuid })
        created++
      }
    }

    // Every tracked rule was created by this app — a tracked itemId no longer
    // declared is always removed (not "did we create it", unlike aliases).
    const declaredItemIds = new Set(specs.map((s) => s.itemId))
    for (const p of prior) {
      if (declaredItemIds.has(p.itemId) || !p.uuid) continue
      const stillLive = liveByUuid.get(p.uuid)
      if (!stillLive) continue // already gone (e.g. removed by hand)
      await deleteFilterRule(client, p.uuid)
      deleted++
    }

    const touched = created + updated + deleted
    const applyNote = touched > 0 ? `applied (${await applyFilterModule(client, FILTER_MODULE)})` : 'nothing to apply'

    return {
      success: true,
      message: `Reconciled ${specs.length} OPNsense filter rule(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed — ${applyNote}.`,
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
