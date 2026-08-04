import type { CanvasSnapshot, DeployContext, DeployResult, PlatformDataApi } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type RoutingGateway } from '../../lib/pfsenseApi'
import { extractSpecs, gatewayKey, snapshotGateway, toGatewayCreateBody, toGatewayUpdateBody } from './_shared'

export interface RollbackEntry {
  name: string
  id: number | string | null
  prior: Omit<RoutingGateway, 'id' | 'name'> | null
}

async function loadPriorEntries(platform: PlatformDataApi, canvas: CanvasSnapshot): Promise<RollbackEntry[]> {
  try {
    const prev = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { previous?: RollbackEntry[] } | undefined
    return Array.isArray(data?.previous) ? data!.previous : []
  } catch {
    return []
  }
}

/**
 * Deploy routing gateways over the pfSense REST API package:
 *   list:    GET  /api/v2/routing/gateways
 *   create:  POST /api/v2/routing/gateway
 *   update:  PATCH /api/v2/routing/gateway (never sends `name` — immutable)
 *   delete (a gateway this app created but no longer declares):
 *            DELETE /api/v2/routing/gateway
 *   apply (once, after every write above): POST /api/v2/routing/apply
 *     — the SAME endpoint the separate Static Routes config type uses
 *     (RoutingApplyDispatcher, verified shared by both RoutingGateway.inc
 *     and StaticRoute.inc), NOT /api/v2/firewall/apply.
 *
 * IDENTITY: `name` (unique, immutable) — same upsert/cleanup posture as
 * firewall-aliases' name-keyed pattern (only removes gateways this app
 * created).
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

  const specs = extractSpecs(items).filter((s) => s.name && s.ipprotocol)
  const previous: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await client.listRoutingGateways()
    const liveByName = new Map(live.filter((g) => g.name).map((g) => [gatewayKey(g.name), g]))
    const prior = await loadPriorEntries(ctx.platform, canvas)

    for (const spec of specs) {
      const match = liveByName.get(gatewayKey(spec.name)) ?? null

      if (match && match.id !== undefined) {
        await client.updateRoutingGateway(match.id, toGatewayUpdateBody(spec))
        previous.push({ name: spec.name, id: match.id, prior: snapshotGateway(match) })
        updated++
      } else {
        const createdGateway = await client.createRoutingGateway(toGatewayCreateBody(spec))
        previous.push({ name: spec.name, id: createdGateway.id ?? null, prior: null })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => gatewayKey(s.name)))
    for (const p of prior) {
      if (p.prior !== null || declaredNames.has(gatewayKey(p.name)) || p.id === null) continue
      await client.deleteRoutingGateway(p.id)
      deleted++
    }

    if (created > 0 || updated > 0 || deleted > 0) {
      await client.applyRoutingChanges()
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} pfSense gateway(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deploy failed after ${created} created, ${updated} updated, ${deleted} removed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous },
    }
  }
}
