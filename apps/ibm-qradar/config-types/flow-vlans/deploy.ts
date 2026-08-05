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
import { extractFlowVlanSpecs, vlanKey, type FlowVlanSpec, type LiveFlowVlan } from './validate'

const PATH = '/ariel/flow_vlans'

export interface RollbackEntry {
  itemId?: string
  label: string
  pairKey: string
  existed: boolean
  id?: number
}

export async function listFlowVlans(client: QRadarClient): Promise<LiveFlowVlan[]> {
  const res = await client.request('GET', PATH, { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveFlowVlan[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

function liveKey(v: LiveFlowVlan): string {
  return `${v.enterprise_vlan_id ?? 0}:${v.customer_vlan_id ?? 0}`
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

  // Identity is the (enterprise, customer) pair, not the canvas item id — there is
  // no update endpoint, so a "renamed" pair is naturally a delete of the old pair
  // plus a create of the new one via the reconcile step below.
  const specs = extractFlowVlanSpecs(ctx.canvas).filter((s) => s.label)
  const prior = await loadPriorEntries(ctx)

  const live = await listFlowVlans(client)
  const byPair = new Map(live.map((v) => [liveKey(v), v]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  let created = 0

  for (const spec of specs) {
    const pairKey = vlanKey(spec)
    const existing = byPair.get(pairKey)
    if (existing) {
      entries.push({ itemId: spec.itemId, label: spec.label, pairKey, existed: true, id: existing.id })
      continue
    }
    const resp = await client.request('POST', PATH, { body: { enterprise_vlan_id: spec.enterpriseVlanId, customer_vlan_id: spec.customerVlanId } })
    if (!resp.ok) {
      failures.push(`${spec.label}: ${qradarErrorMessage(resp)}`)
      continue
    }
    const made = parseJson<LiveFlowVlan>(resp.body)
    created++
    entries.push({ itemId: spec.itemId, label: spec.label, pairKey, existed: false, id: made?.id })
  }

  // Reconcile: delete pairs THIS app created previously but no longer declares.
  const declaredPairs = new Set(specs.map((s) => vlanKey(s)))
  for (const p of prior) {
    if (!p.existed && typeof p.id === 'number' && !declaredPairs.has(p.pairKey)) {
      const resp = await client.request('DELETE', `${PATH}/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.label}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some flow VLANs failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Ensured ${entries.length} flow VLAN(s) (${created} created)`, rollbackData: { entries } }
}
