import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { addHostOverride, deleteHostOverride, reconfigureUnbound, searchHostOverrides, setHostOverride, type LiveHostOverride } from '../../lib/unboundApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { buildHostOverrideBody, extractHostOverrideSpecs, hostOverrideKey, snapshotLive, type HostOverrideSpec } from './_shared'
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
 * Deploy OPNsense Unbound host overrides via /api/unbound/settings.
 *
 * Identity is the (hostname, domain) composite (see _shared.ts). Missing
 * overrides are created (addHostOverride), existing ones updated
 * (setHostOverride, always sending every managed field), and overrides this
 * app previously created but no longer declares are removed
 * (deleteHostOverride, which also deletes any dependent host aliases —
 * see lib/unboundApi.ts's doc).
 *
 * Stage then apply ONCE: `/api/unbound/service/reconfigure` — which, per
 * ApiMutableServiceControllerBase's default, STOPS THEN STARTS the Unbound
 * resolver (not a soft reload), so every deploy that touches a host override
 * causes a brief DNS resolution gap on the box.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const specs: HostOverrideSpec[] = extractHostOverrideSpecs(ctx.canvas).filter((s) => s.hostname && s.domain)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await searchHostOverrides(client)
    const liveByKey = new Map<string, LiveHostOverride>(
      live.filter((h) => h.hostname && h.domain).map((h) => [hostOverrideKey(h.hostname as string, h.domain as string), h]),
    )
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const key = hostOverrideKey(spec.hostname, spec.domain)
      const match = liveByKey.get(key) ?? null
      const body = buildHostOverrideBody(spec)

      if (match) {
        await setHostOverride(client, match.uuid, body)
        entries.push({ itemId: spec.itemId, key, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const uuid = await addHostOverride(client, body)
        entries.push({ itemId: spec.itemId, key, existed: false, uuid })
        created++
      }
    }

    const declaredKeys = new Set(specs.map((s) => hostOverrideKey(s.hostname, s.domain)))
    for (const p of prior) {
      if (p.existed || declaredKeys.has(p.key)) continue
      const stillLive = liveByKey.get(p.key)
      if (!stillLive) continue
      await deleteHostOverride(client, stillLive.uuid)
      deleted++
    }

    const touched = created + updated + deleted
    if (touched > 0) {
      await reconfigureUnbound(client)
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} OPNsense host override(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed${
        touched > 0 ? ' (applied — Unbound was restarted)' : ' (nothing to apply)'
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
