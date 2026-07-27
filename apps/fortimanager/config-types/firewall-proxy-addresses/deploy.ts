import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace } from '../firewall-addresses/deploy'
import { extractProxyAddressSpecs, liveStringList, normalizeScalar, type LiveProxyAddress, type ProxyAddressSpec } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** The ADOM-scoped explicit-proxy address object path. */
export function proxyAddressUrl(adom: string): string {
  return `/pm/config/adom/${adom}/obj/firewall/proxy-address`
}

export function buildProxyAddressBody(spec: ProxyAddressSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, type: spec.type }
  if (spec.type === 'host-regex') {
    body['host-regex'] = spec.hostRegex
  } else if (spec.type === 'url') {
    body.host = spec.host
    body.path = spec.path
  } else if (spec.type === 'method') {
    body.host = spec.host
    body.method = spec.methods
  } else if (spec.type === 'ua') {
    body.host = spec.host
    body.ua = spec.userAgents
  }
  if (spec.comment) body.comment = spec.comment
  return body
}

export function snapshotLive(live: LiveProxyAddress): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  if (live.type !== undefined) body.type = live.type
  const host = normalizeScalar(live.host)
  if (host) body.host = host
  if (live['host-regex'] !== undefined) body['host-regex'] = live['host-regex']
  if (live.path !== undefined) body.path = live.path
  const methods = liveStringList(live.method)
  if (methods.length) body.method = methods
  const userAgents = liveStringList(live.ua)
  if (userAgents.length) body.ua = userAgents
  if (live.comment !== undefined) body.comment = live.comment
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
  const url = proxyAddressUrl(settings.adom)
  const specs = extractProxyAddressSpecs(ctx.canvas).filter((s) => s.name)
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
      const live = Array.isArray(listed.data) ? (listed.data as LiveProxyAddress[]) : []
      const liveByName = new Map<string, LiveProxyAddress>()
      for (const a of live) if (a.name) liveByName.set(a.name.toLowerCase(), a)

      const prior = await loadPriorEntries(ctx)

      for (const spec of specs) {
        const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
        const resp = await client.set(url, buildProxyAddressBody(spec))
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
    return { success: false, message: `Some proxy addresses failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} explicit-proxy address(es)`, rollbackData: { entries } }
}
