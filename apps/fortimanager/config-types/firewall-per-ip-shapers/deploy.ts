import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace } from '../firewall-addresses/deploy'
import { extractPerIpShaperSpecs, type PerIpShaperSpec, type LivePerIpShaper } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** The ADOM-scoped per-IP traffic-shaper object path. */
export function perIpShaperUrl(adom: string): string {
  return `/pm/config/adom/${adom}/obj/firewall/shaper/per-ip-shaper`
}

export function buildPerIpShaperBody(spec: PerIpShaperSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    'bandwidth-unit': spec.bandwidthUnit,
    'diffserv-forward': spec.diffservForward,
    'diffserv-reverse': spec.diffservReverse,
  }
  if (spec.maxBandwidth !== undefined) body['max-bandwidth'] = spec.maxBandwidth
  if (spec.maxConcurrentSession !== undefined) body['max-concurrent-session'] = spec.maxConcurrentSession
  if (spec.maxConcurrentTcpSession !== undefined) body['max-concurrent-tcp-session'] = spec.maxConcurrentTcpSession
  if (spec.maxConcurrentUdpSession !== undefined) body['max-concurrent-udp-session'] = spec.maxConcurrentUdpSession
  return body
}

export function snapshotLive(live: LivePerIpShaper): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of [
    'max-bandwidth',
    'bandwidth-unit',
    'max-concurrent-session',
    'max-concurrent-tcp-session',
    'max-concurrent-udp-session',
    'diffserv-forward',
    'diffserv-reverse',
  ] as const) {
    if (live[k] !== undefined) body[k] = live[k]
  }
  return body
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildFmgClient(cred, settings)
  const url = perIpShaperUrl(settings.adom)
  const specs = extractPerIpShaperSpecs(ctx.canvas).filter((s) => s.name)
  const failures: string[] = []
  const entries: RollbackEntry[] = []

  if (settings.workspaceMode) {
    const lock = await client.lock(settings.adom)
    if (!lock.ok) {
      await client.logout()
      return { success: false, message: `Failed to lock ADOM "${settings.adom}": ${fmgErrorMessage(lock)}` }
    }
  }

  try {
    const listed = await client.get(url)
    if (!listed.ok) {
      failures.push(`list: ${fmgErrorMessage(listed)}`)
    } else {
      const live = Array.isArray(listed.data) ? (listed.data as LivePerIpShaper[]) : []
      const liveByName = new Map<string, LivePerIpShaper>()
      for (const s of live) if (s.name) liveByName.set(s.name.toLowerCase(), s)

      const prior = await loadPriorEntries(ctx)

      for (const spec of specs) {
        const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
        const resp = await client.set(url, buildPerIpShaperBody(spec))
        if (!resp.ok) {
          failures.push(`${spec.name}: ${fmgErrorMessage(resp)}`)
          continue
        }
        entries.push({ itemId: spec.itemId, name: spec.name, existed: !!liveMatch, prior: liveMatch ? snapshotLive(liveMatch) : undefined })
      }

      const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
      for (const p of prior) {
        if (!p.existed && !declaredNames.has(p.name.toLowerCase())) {
          const resp = await client.delete(url, ['name', '==', p.name])
          if (!resp.ok) failures.push(`delete ${p.name}: ${fmgErrorMessage(resp)}`)
        }
      }
    }

    if (settings.workspaceMode) await finishWorkspace(client, settings.adom, failures)
  } finally {
    await client.logout()
  }

  if (failures.length) {
    return { success: false, message: `Some per-IP shapers failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} firewall per-IP shaper(s)`, rollbackData: { entries } }
}
