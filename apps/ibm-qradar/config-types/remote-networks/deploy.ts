import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  parseJson,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type QRadarClient,
} from '../../lib/qradar'
import { extractRemoteNetworkSpecs, type LiveRemoteNetwork, type RemoteNetworkSpec } from './validate'

export interface RemoteNetworkState {
  name: string
  description: string
  group: string
  cidrs: string[]
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  /** the QRadar remote-network id, for rename-safe matching and delete/restore. */
  id?: number
  prior?: RemoteNetworkState
}

export async function listRemoteNetworks(client: QRadarClient): Promise<LiveRemoteNetwork[]> {
  const res = await client.request('GET', '/staged_config/remote_networks', { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveRemoteNetwork[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

function sameCidrs(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sb = new Set(b)
  return a.every((x) => sb.has(x))
}

function bodyOf(spec: RemoteNetworkSpec): RemoteNetworkState {
  return { name: spec.name, description: spec.description, group: spec.group, cidrs: spec.cidrs }
}

function stateOf(live: LiveRemoteNetwork): RemoteNetworkState {
  return { name: live.name ?? '', description: live.description ?? '', group: live.group ?? '', cidrs: live.cidrs ?? [] }
}

function differs(a: RemoteNetworkState, b: RemoteNetworkState): boolean {
  return a.name !== b.name || a.description !== b.description || a.group !== b.group || !sameCidrs(a.cidrs, b.cidrs)
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
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const specs = extractRemoteNetworkSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId as string, p]))
  const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

  const live = await listRemoteNetworks(client)
  const byId = new Map(live.filter((n) => typeof n.id === 'number').map((n) => [n.id as number, n]))
  const byName = new Map(live.filter((n) => n.name).map((n) => [String(n.name).toLowerCase(), n]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  let changed = false

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItem.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const existing = (priorEntry?.id !== undefined && byId.get(priorEntry.id)) || byName.get(spec.name.toLowerCase())

    if (existing && typeof existing.id === 'number') {
      const priorState = stateOf(existing)
      if (differs(priorState, bodyOf(spec))) {
        const resp = await client.request('POST', `/staged_config/remote_networks/${existing.id}`, { body: bodyOf(spec) })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
        changed = true
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: existing.id, prior: priorState })
    } else {
      const resp = await client.request('POST', '/staged_config/remote_networks', { body: bodyOf(spec) })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveRemoteNetwork>(resp.body)
      changed = true
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete remote networks THIS app created previously but no longer declares.
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter(Boolean))
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && typeof p.id === 'number' && !(p.itemId && declaredItemIds.has(p.itemId)) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.request('DELETE', `/staged_config/remote_networks/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
      else changed = true
    }
  }

  // STAGED: apply the staged changes with a single INCREMENTAL deploy (single-flight tolerant).
  if (changed) {
    const dep = await client.deployStagedConfig('INCREMENTAL')
    if (!dep.ok) failures.push(`deploy: ${dep.message}`)
  }

  if (failures.length) {
    return { success: false, message: `Some remote networks failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} remote network(s)`, rollbackData: { entries } }
}
