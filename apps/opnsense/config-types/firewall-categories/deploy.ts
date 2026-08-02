import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { addCategory, buildOpnsenseClient, deleteCategory, searchCategories, setCategory, type LiveCategory } from '../../lib/opnsenseApi'
import { buildCategoryBody, categoryKey, extractCategorySpecs, isSystemManaged, snapshotLive, type CategorySpec } from './_shared'
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
 * Deploy OPNsense firewall categories via /api/firewall/category.
 *
 * Identity is the category `name`: list every configured category
 * (searchItem), match on the name, and addItem (create) / setItem (update)
 * each declared category. Categories this app created in a prior successful
 * deploy but no longer declares are removed (delItem) — blocked by OPNsense
 * itself, surfaced as a deploy error, if any alias/rule/NAT entry still
 * references it. System-managed categories (`auto: "1"`, e.g. an
 * Anti-Lockout category some NAT versions auto-create) are never matched,
 * updated or deleted by this app.
 *
 * Categories are pure metadata with no live pf effect (verified: no
 * apply/reconfigure action exists on CategoryController) — so unlike
 * firewall-aliases/firewall-rules/source-nat, this deploy has no apply step
 * at all; staging IS the whole deploy.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const specs: CategorySpec[] = extractCategorySpecs(ctx.canvas).filter((s) => s.name)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await searchCategories(client)
    const manageable = live.filter((c) => !isSystemManaged(c))
    const liveByName = new Map<string, LiveCategory>(manageable.filter((c) => c.name).map((c) => [categoryKey(c.name as string), c]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(categoryKey(spec.name)) ?? null
      const body = buildCategoryBody(spec)

      if (match) {
        await setCategory(client, match.uuid, body)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const uuid = await addCategory(client, body)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, uuid })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => categoryKey(s.name)))
    for (const p of prior) {
      if (p.existed || declaredNames.has(categoryKey(p.name))) continue
      const stillLive = liveByName.get(categoryKey(p.name))
      if (!stillLive) continue
      await deleteCategory(client, stillLive.uuid)
      deleted++
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} OPNsense firewall categor${specs.length === 1 ? 'y' : 'ies'} on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { entries },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deploy failed after ${created} created, ${updated} updated, ${deleted} removed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { entries },
    }
  }
}
