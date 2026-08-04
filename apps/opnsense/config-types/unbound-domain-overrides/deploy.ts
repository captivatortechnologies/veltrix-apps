import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { addDomainOverride, deleteDomainOverride, reconfigureUnbound, searchDomainOverrides, setDomainOverride, type LiveDomainOverride } from '../../lib/unboundApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { buildDomainOverrideBody, domainOverrideKey, extractDomainOverrideSpecs, snapshotLive, type DomainOverrideSpec } from './_shared'
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
 * Deploy OPNsense Unbound domain (forward) overrides via
 * /api/unbound/settings. Identity is `domain` (see _shared.ts). Reconciles
 * against ONLY `type: "forward"` live entries — a domain independently
 * configured as a DNS-over-TLS entry via the GUI is matched by domain too
 * and, per addForward/setForward's own overlay, silently converted to a
 * plain forward on this app's next deploy (see lib/unboundApi.ts's module
 * doc — verified server behavior, not a guess).
 *
 * Stage then apply ONCE: `/api/unbound/service/reconfigure` (restarts the
 * Unbound resolver — see unbound-host-overrides for the same caveat).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const specs: DomainOverrideSpec[] = extractDomainOverrideSpecs(ctx.canvas).filter((s) => s.domain)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = (await searchDomainOverrides(client)).filter((d) => (d.type ?? 'forward') === 'forward')
    const liveByKey = new Map<string, LiveDomainOverride>(live.filter((d) => d.domain).map((d) => [domainOverrideKey(d.domain as string), d]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const key = domainOverrideKey(spec.domain)
      const match = liveByKey.get(key) ?? null
      const body = buildDomainOverrideBody(spec)

      if (match) {
        await setDomainOverride(client, match.uuid, body)
        entries.push({ itemId: spec.itemId, key, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const uuid = await addDomainOverride(client, body)
        entries.push({ itemId: spec.itemId, key, existed: false, uuid })
        created++
      }
    }

    const declaredKeys = new Set(specs.map((s) => domainOverrideKey(s.domain)))
    for (const p of prior) {
      if (p.existed || declaredKeys.has(p.key)) continue
      const stillLive = liveByKey.get(p.key)
      if (!stillLive) continue
      await deleteDomainOverride(client, stillLive.uuid)
      deleted++
    }

    const touched = created + updated + deleted
    if (touched > 0) {
      await reconfigureUnbound(client)
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} OPNsense domain override(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed${
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
