import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient, umbrellaErrorMessage } from '../../lib/umbrellaApi'
import { DEPLOYMENTS_TUNNELS_PATH, listDeployment } from '../../lib/deployments'
import { extractTunnelSpecs, liveDeviceType, resolveSiteOriginId, tunnelCreateBody, type LiveTunnel } from './_shared'

export interface TunnelRollbackEntry {
  itemId?: string
  key: string
  name: string
  /** Whether the tunnel existed before THIS deploy. Tunnels have no update
   * endpoint, so "existed: true" entries are informational only — rollback
   * cannot restore a prior configuration for them, only for created ones. */
  existed: boolean
  tunnelId?: number | string
}

async function loadPriorEntries(ctx: DeployContext): Promise<TunnelRollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: TunnelRollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as TunnelRollbackEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Deploy Umbrella network tunnels. Tunnels have no confirmed update endpoint,
 * so an existing tunnel is left untouched (a note is emitted if its device
 * type looks different from what's declared) — only missing tunnels are
 * created, and reconcile deletes tunnels this app created but no longer
 * declares.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractTunnelSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await listDeployment<LiveTunnel>(client, DEPLOYMENTS_TUNNELS_PATH)
  if (!listed.ok) {
    return { success: false, message: `Failed to list tunnels: ${listed.lastError}` }
  }
  const liveByKey = new Map<string, LiveTunnel>()
  const liveById = new Map<string, LiveTunnel>()
  for (const l of listed.items) {
    const name = typeof l.name === 'string' ? l.name.toLowerCase() : ''
    if (name) liveByKey.set(name, l)
    if (l.id != null) liveById.set(String(l.id), l)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: TunnelRollbackEntry[] = []
  const failures: string[] = []
  const notes: string[] = []

  for (const spec of specs) {
    const key = spec.name.toLowerCase()
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const liveMatch =
      (priorEntry?.tunnelId != null ? liveById.get(String(priorEntry.tunnelId)) : undefined) ??
      liveByKey.get(key) ??
      null

    if (liveMatch?.id != null) {
      const live = liveDeviceType(liveMatch)
      if (live && live.toLowerCase() !== spec.deviceType.toLowerCase()) {
        notes.push(
          `"${spec.name}": device type is "${live}" in Umbrella and cannot be changed to "${spec.deviceType}" ` +
            'in place (tunnels have no update endpoint — remove and re-declare to recreate it)',
        )
      }
      entries.push({ itemId: spec.itemId, key, name: spec.name, existed: true, tunnelId: liveMatch.id })
      continue
    }

    const siteOriginId = await resolveSiteOriginId(client, spec.siteName)
    if (spec.siteName && siteOriginId == null) {
      notes.push(`"${spec.name}": site "${spec.siteName}" was not found in Umbrella — tunnel created with no site association`)
    }
    const created = await client.post(DEPLOYMENTS_TUNNELS_PATH, tunnelCreateBody(spec, siteOriginId))
    if (!created.ok) {
      failures.push(`create tunnel "${spec.name}": ${umbrellaErrorMessage(created)}`)
      continue
    }
    const body = JSON.parse(created.body || '{}') as { id?: number | string }
    if (body.id == null) {
      failures.push(`create tunnel "${spec.name}": Umbrella returned no tunnel id`)
      continue
    }
    entries.push({ itemId: spec.itemId, key, name: spec.name, existed: false, tunnelId: body.id })
  }

  // Reconcile: delete tunnels THIS app created previously but no longer declares.
  const declaredKeys = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => (e.tunnelId != null ? String(e.tunnelId) : '')).filter(Boolean))
  for (const p of prior) {
    if (p.existed || p.tunnelId == null) continue
    if (keptIds.has(String(p.tunnelId)) || declaredKeys.has(p.key)) continue
    const res = await client.delete(`${DEPLOYMENTS_TUNNELS_PATH}/${encodeURIComponent(String(p.tunnelId))}`)
    if (!res.ok && res.status !== 404) failures.push(`delete tunnel "${p.name}": ${umbrellaErrorMessage(res)}`)
  }

  const noteSuffix = notes.length ? ` Notes: ${notes.join('; ')}.` : ''
  if (failures.length) {
    return {
      success: false,
      message: `Some tunnels failed: ${failures.join('; ')}.${noteSuffix}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} tunnel(s).${noteSuffix}`,
    artifacts: { applied: entries.map((e) => e.name) },
    rollbackData: { entries },
  }
}
