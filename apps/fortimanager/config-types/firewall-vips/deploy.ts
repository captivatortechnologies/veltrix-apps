import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace } from '../firewall-addresses/deploy'
import { extractVipSpecs, normalizeScalar, normalizeVipIp, VIP_TYPE, type LiveVip, type VipSpec } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** The ADOM-scoped virtual IP object path. */
export function vipUrl(adom: string): string {
  return `/pm/config/adom/${adom}/obj/firewall/vip`
}

export function buildVipBody(spec: VipSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    type: VIP_TYPE,
    extip: spec.extip,
    mappedip: spec.mappedip,
    portforward: spec.portforward,
    'arp-reply': spec.arpReply,
  }
  if (spec.extintf) body.extintf = spec.extintf
  if (spec.portforward === 'enable') {
    body.protocol = spec.protocol
    if (spec.extport) body.extport = spec.extport
    if (spec.mappedport) body.mappedport = spec.mappedport
  }
  if (spec.comment) body.comment = spec.comment
  return body
}

export function snapshotLive(live: LiveVip): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name, type: VIP_TYPE }
  const extip = normalizeVipIp(live.extip)
  if (extip) body.extip = extip
  const mappedip = normalizeVipIp(live.mappedip)
  if (mappedip) body.mappedip = mappedip
  const extintf = normalizeScalar(live.extintf)
  if (extintf) body.extintf = extintf
  for (const k of ['extport', 'mappedport', 'portforward', 'arp-reply', 'comment'] as const) {
    if (live[k] !== undefined) body[k] = live[k]
  }
  if (live.protocol !== undefined) body.protocol = live.protocol
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
  const url = vipUrl(settings.adom)
  const specs = extractVipSpecs(ctx.canvas).filter((s) => s.name)
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
      const live = Array.isArray(listed.data) ? (listed.data as LiveVip[]) : []
      const liveByName = new Map<string, LiveVip>()
      for (const v of live) if (v.name) liveByName.set(v.name.toLowerCase(), v)

      const prior = await loadPriorEntries(ctx)

      for (const spec of specs) {
        const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
        const resp = await client.set(url, buildVipBody(spec))
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
    return { success: false, message: `Some virtual IPs failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} firewall virtual IP(s)`, rollbackData: { entries } }
}
