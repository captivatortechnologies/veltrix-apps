import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  addSourceNatRule,
  applyFilterModule,
  buildOpnsenseClient,
  deleteSourceNatRule,
  getSourceNatMode,
  searchCategories,
  searchSourceNatRules,
  setSourceNatRule,
  SOURCE_NAT_MODULE,
  type LiveCategory,
  type LiveSourceNatRule,
} from '../../lib/opnsenseApi'
import { buildSourceNatRuleBody, extractSourceNatRuleSpecs, modeHonorsManualRules, snapshotLive, type SourceNatRuleSpec } from './_shared'
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
 * Deploy OPNsense outbound (source) NAT rules via /api/firewall/source_nat
 * (REQUIRES OPNsense 24.1+ — see lib/opnsenseApi.ts's SOURCE_NAT_MODULE doc).
 *
 * Identity is the CANVAS ITEM's own stable id, exactly like firewall-rules —
 * `snatrules.rule` has no name field either. Every tracked rule was created
 * BY THIS APP, so a tracked itemId no longer declared is always removed.
 *
 * Stage (addRule/setRule/delRule) then apply ONCE
 * (`/api/firewall/source_nat/apply` — the SAME backend reload
 * FilterBaseController::applyAction runs for firewall-filter, see
 * lib/opnsenseApi.ts's applyFilterModule doc).
 *
 * MODE GATE: manual outbound NAT rules only take effect when
 * `general.snat_mode` is "hybrid" or "advanced" ("manual"). This app does
 * NOT change that global setting — it only warns, prominently, in the
 * deploy's own success message and in healthCheck, when the live mode would
 * make these staged-and-applied rules have zero real effect.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const specs: SourceNatRuleSpec[] = extractSourceNatRuleSpecs(ctx.canvas)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const [liveRules, liveCategories] = await Promise.all([searchSourceNatRules(client), searchCategories(client)])
    const categoryByName = new Map<string, LiveCategory>(liveCategories.filter((c) => c.name).map((c) => [c.name as string, c]))
    const liveByUuid = new Map<string, LiveSourceNatRule>(liveRules.map((r) => [r.uuid, r]))
    const prior = await loadPriorEntries(ctx)
    const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

    for (const spec of specs) {
      const categoryUuids = resolveCategoryUuids(spec.categories, categoryByName)
      const body = buildSourceNatRuleBody(spec, categoryUuids)

      const priorEntry = priorByItemId.get(spec.itemId)
      const existingLive = priorEntry?.uuid ? liveByUuid.get(priorEntry.uuid) : undefined

      if (existingLive) {
        await setSourceNatRule(client, existingLive.uuid, body)
        entries.push({ itemId: spec.itemId, description: spec.description, existed: true, uuid: existingLive.uuid, prior: snapshotLive(existingLive) })
        updated++
      } else {
        const uuid = await addSourceNatRule(client, body)
        entries.push({ itemId: spec.itemId, description: spec.description, existed: false, uuid })
        created++
      }
    }

    const declaredItemIds = new Set(specs.map((s) => s.itemId))
    for (const p of prior) {
      if (declaredItemIds.has(p.itemId) || !p.uuid) continue
      const stillLive = liveByUuid.get(p.uuid)
      if (!stillLive) continue
      await deleteSourceNatRule(client, p.uuid)
      deleted++
    }

    const touched = created + updated + deleted
    const applyNote = touched > 0 ? `applied (${await applyFilterModule(client, SOURCE_NAT_MODULE)})` : 'nothing to apply'

    const mode = await getSourceNatMode(client).catch(() => null)
    const modeNote =
      specs.length > 0 && mode !== null && !modeHonorsManualRules(mode)
        ? ` WARNING: Outbound NAT mode is "${mode}" — manual rules have NO EFFECT until it is set to Hybrid or Manual.`
        : ''

    return {
      success: true,
      message: `Reconciled ${specs.length} OPNsense source NAT rule(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed — ${applyNote}.${modeNote}`,
      artifacts: { host, created, updated, deleted, snatMode: mode },
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
