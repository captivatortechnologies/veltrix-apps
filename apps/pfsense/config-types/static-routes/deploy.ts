import type { CanvasSnapshot, DeployContext, DeployResult, PlatformDataApi } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type StaticRoute } from '../../lib/pfsenseApi'
import { extractSpecs, snapshotStaticRoute, toStaticRouteBody } from './_shared'

/** One tracked route, keyed by the CANVAS ITEM's stable id — see _shared.ts's module doc on identity. */
export interface RollbackEntry {
  itemId: string
  id: number | string
  prior: Omit<StaticRoute, 'id'> | null
}

/** Shared by deploy/rollback/driftDetect/healthCheck — the last successfully-deployed itemId->pfsenseId map. */
export async function loadPriorEntries(platform: PlatformDataApi, canvas: CanvasSnapshot): Promise<RollbackEntry[]> {
  try {
    const prev = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { previous?: RollbackEntry[] } | undefined
    return Array.isArray(data?.previous) ? data!.previous : []
  } catch {
    return []
  }
}

/**
 * Deploy static routes over the pfSense REST API package:
 *   list:    GET  /api/v2/routing/static_routes
 *   create:  POST /api/v2/routing/static_route
 *   update:  PATCH /api/v2/routing/static_route
 *   delete:  DELETE /api/v2/routing/static_route
 *   apply (once, after every write above): POST /api/v2/routing/apply
 *     — the SAME endpoint the separate Gateways config type uses
 *     (RoutingApplyDispatcher, verified shared by both StaticRoute.inc and
 *     RoutingGateway.inc), NOT /api/v2/firewall/apply.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const auth = await client.authenticate()
  if (auth.error) return { success: false, message: auth.error }

  const specs = extractSpecs(items).filter((s) => s.itemId && s.network && s.gateway)
  const newEntries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await client.listStaticRoutes()
    const liveById = new Map(live.filter((r) => r.id !== undefined).map((r) => [String(r.id), r]))
    const prior = await loadPriorEntries(ctx.platform, canvas)
    const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

    for (const spec of specs) {
      const priorEntry = priorByItemId.get(spec.itemId)
      const liveMatch = priorEntry ? liveById.get(String(priorEntry.id)) : undefined

      if (priorEntry && liveMatch) {
        await client.updateStaticRoute(priorEntry.id, toStaticRouteBody(spec))
        newEntries.push({ itemId: spec.itemId, id: priorEntry.id, prior: snapshotStaticRoute(liveMatch) })
        updated++
      } else {
        const createdRoute = await client.createStaticRoute(toStaticRouteBody(spec))
        newEntries.push({ itemId: spec.itemId, id: createdRoute.id!, prior: null })
        created++
      }
    }

    const declaredItemIds = new Set(specs.map((s) => s.itemId))
    for (const p of prior) {
      if (declaredItemIds.has(p.itemId)) continue
      await client.deleteStaticRoute(p.id)
      deleted++
    }

    if (created > 0 || updated > 0 || deleted > 0) {
      await client.applyRoutingChanges()
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} pfSense static route(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous: newEntries },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deploy failed after ${created} created, ${updated} updated, ${deleted} removed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous: newEntries },
    }
  }
}
