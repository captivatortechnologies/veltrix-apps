import type { CanvasSnapshot, DeployContext, DeployResult, PlatformDataApi } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type PortForward } from '../../lib/pfsenseApi'
import { extractSpecs, snapshotPortForward, toPortForwardCreateBody, toPortForwardUpdateBody } from './_shared'

/** One tracked port forward, keyed by the CANVAS ITEM's stable id — see _shared.ts's module doc on identity. */
export interface RollbackEntry {
  itemId: string
  id: number | string
  prior: Omit<PortForward, 'id'> | null
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
 * Deploy NAT port forwards over the pfSense REST API package:
 *   list:    GET  /api/v2/firewall/nat/port_forwards
 *   create:  POST /api/v2/firewall/nat/port_forward
 *   update:  PATCH /api/v2/firewall/nat/port_forward
 *   delete:  DELETE /api/v2/firewall/nat/port_forward
 *   apply (once, after every write above): POST /api/v2/firewall/apply
 *     ('natconf' IS in FirewallApply's subsystem list — verified — so the
 *     SAME shared apply endpoint as aliases/rules covers port forwards.)
 *
 * IDENTITY: see this config type's _shared.ts module doc — pfSense port
 * forwards have no unique field, so identity is tracked by canvas-item id
 * across deploys, same pattern as firewall-rules. A tracked entry always
 * belongs to THIS app, so removing a declared item always deletes the port
 * forward it produced.
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

  const specs = extractSpecs(items).filter((s) => s.itemId && s.interface && s.protocol)
  const newEntries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await client.listPortForwards()
    const liveById = new Map(live.filter((pf) => pf.id !== undefined).map((pf) => [String(pf.id), pf]))
    const prior = await loadPriorEntries(ctx.platform, canvas)
    const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

    for (const spec of specs) {
      const priorEntry = priorByItemId.get(spec.itemId)
      const liveMatch = priorEntry ? liveById.get(String(priorEntry.id)) : undefined
      const placement = spec.position !== null ? { placement: spec.position } : undefined

      if (priorEntry && liveMatch) {
        await client.updatePortForward(priorEntry.id, toPortForwardUpdateBody(spec), placement)
        newEntries.push({ itemId: spec.itemId, id: priorEntry.id, prior: snapshotPortForward(liveMatch) })
        updated++
      } else {
        const createdPf = await client.createPortForward(toPortForwardCreateBody(spec), placement)
        newEntries.push({ itemId: spec.itemId, id: createdPf.id!, prior: null })
        created++
      }
    }

    const declaredItemIds = new Set(specs.map((s) => s.itemId))
    for (const p of prior) {
      if (declaredItemIds.has(p.itemId)) continue
      await client.deletePortForward(p.id)
      deleted++
    }

    if (created > 0 || updated > 0 || deleted > 0) {
      await client.applyChanges()
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} pfSense NAT port forward(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
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
