import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { addRoute, deleteRoute, reconfigureRoutes, searchRoutes, setRoute, type LiveRoute } from '../../lib/staticRoutesApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { buildRouteBody, extractRouteSpecs, routeKey, snapshotLive, type RouteSpec } from './_shared'
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
 * Deploy OPNsense static routes via /api/routes/routes. Identity is
 * `network` (see _shared.ts). Missing routes are created (addroute),
 * existing ones updated (setroute, always sending every managed field), and
 * routes this app previously created but no longer declares are removed
 * (delroute). Every stage call defers the actual OS routing-table change to
 * a `/tmp/delete_route_<uuid>.todo` marker (server-side bookkeeping — see
 * lib/staticRoutesApi.ts's module doc); stage then apply ONCE
 * (`/api/routes/routes/reconfigure`, runs `interface routes configure`).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const specs: RouteSpec[] = extractRouteSpecs(ctx.canvas).filter((s) => s.network)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await searchRoutes(client)
    const liveByKey = new Map<string, LiveRoute>(live.filter((r) => r.network).map((r) => [routeKey(r.network as string), r]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const key = routeKey(spec.network)
      const match = liveByKey.get(key) ?? null
      const body = buildRouteBody(spec)

      if (match) {
        await setRoute(client, match.uuid, body)
        entries.push({ itemId: spec.itemId, key, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const uuid = await addRoute(client, body)
        entries.push({ itemId: spec.itemId, key, existed: false, uuid })
        created++
      }
    }

    const declaredKeys = new Set(specs.map((s) => routeKey(s.network)))
    for (const p of prior) {
      if (p.existed || declaredKeys.has(p.key)) continue
      const stillLive = liveByKey.get(p.key)
      if (!stillLive) continue
      await deleteRoute(client, stillLive.uuid)
      deleted++
    }

    const touched = created + updated + deleted
    if (touched > 0) {
      await reconfigureRoutes(client)
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} OPNsense static route(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed${
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
