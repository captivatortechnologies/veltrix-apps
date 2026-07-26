import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace } from '../firewall-addresses/deploy'
import { extractServiceSpecs, type LiveService, type ServiceSpec } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** The ADOM-scoped custom-service object path. */
export function serviceUrl(adom: string): string {
  return `/pm/config/adom/${adom}/obj/firewall/service/custom`
}

export function buildServiceBody(spec: ServiceSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, protocol: spec.protocol }
  if (spec.comment) body.comment = spec.comment
  if (spec.protocol === 'TCP/UDP/SCTP') {
    if (spec.tcpPortrange.length) body['tcp-portrange'] = spec.tcpPortrange
    if (spec.udpPortrange.length) body['udp-portrange'] = spec.udpPortrange
    if (spec.sctpPortrange.length) body['sctp-portrange'] = spec.sctpPortrange
  } else if (spec.protocol === 'IP') {
    body['protocol-number'] = Number(spec.protocolNumber)
  } else {
    if (spec.icmptype) body.icmptype = Number(spec.icmptype)
    if (spec.icmpcode) body.icmpcode = Number(spec.icmpcode)
  }
  return body
}

export function snapshotLive(live: LiveService): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of ['protocol', 'tcp-portrange', 'udp-portrange', 'sctp-portrange', 'protocol-number', 'icmptype', 'icmpcode', 'comment'] as const) {
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
  const url = serviceUrl(settings.adom)
  const specs = extractServiceSpecs(ctx.canvas).filter((s) => s.name)
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
      const live = Array.isArray(listed.data) ? (listed.data as LiveService[]) : []
      const liveByName = new Map<string, LiveService>()
      for (const s of live) if (s.name) liveByName.set(s.name.toLowerCase(), s)

      const prior = await loadPriorEntries(ctx)

      for (const spec of specs) {
        const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
        const resp = await client.set(url, buildServiceBody(spec))
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
    return { success: false, message: `Some services failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} firewall service(s)`, rollbackData: { entries } }
}
