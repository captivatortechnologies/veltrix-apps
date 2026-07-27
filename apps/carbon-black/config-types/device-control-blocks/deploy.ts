import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  parseJson,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type CbClient,
} from '../../lib/carbonblack'
import type { LivePolicySummary } from '../policies/validate'
import { extractBlockSpecs, type BlockSpec, type LiveBlock } from './validate'

export interface RollbackEntry {
  itemId?: string
  /** the resolved policy id — the block's identity. */
  name: string
  existed: boolean
  id?: string
  /** the original pre-management block body, so rollback can restore it. */
  prior?: Record<string, unknown>
}

export function buildBody(spec: BlockSpec, policyId: string): Record<string, unknown> {
  return {
    policy_id: policyId,
    windows: {
      approved_devices: {
        allow_write: spec.allowWrite,
        allow_execute: spec.allowExecute,
      },
    },
  }
}

export function snapshotLive(live: LiveBlock): Record<string, unknown> {
  return {
    policy_id: live.policy_id,
    windows: { approved_devices: { ...(live.windows?.approved_devices ?? {}) } },
  }
}

/** Whether a live block already equals the desired spec. */
export function definitionEquals(live: LiveBlock, spec: BlockSpec): boolean {
  const ad = live.windows?.approved_devices ?? {}
  return (ad.allow_write ?? false) === spec.allowWrite && (ad.allow_execute ?? false) === spec.allowExecute
}

async function listPolicies(client: CbClient, summaryPath: string): Promise<{ ok: boolean; items: LivePolicySummary[]; err?: string }> {
  const res = await client.get(summaryPath)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ policies?: LivePolicySummary[] } | LivePolicySummary[]>(res.body)
  const items = Array.isArray(parsed) ? parsed : parsed?.policies ?? []
  return { ok: true, items }
}

async function listBlocks(client: CbClient, base: string): Promise<{ ok: boolean; items: LiveBlock[]; err?: string }> {
  const res = await client.get(base)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ results?: LiveBlock[] } | LiveBlock[]>(res.body)
  const items = Array.isArray(parsed) ? parsed : parsed?.results ?? []
  return { ok: true, items }
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
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildCbClient(cred, settings)
  const base = client.deviceControlPath('blocks')
  const summaryPath = `${client.policiesPath()}/summary`

  const specs = extractBlockSpecs(ctx.canvas).filter((s) => s.policyName)

  const policies = await listPolicies(client, summaryPath)
  if (!policies.ok) return { success: false, message: `Failed to list policies: ${policies.err}` }
  const policyIdByName = new Map<string, string>()
  for (const p of policies.items) {
    if (p.name && p.id !== undefined && p.id !== null) policyIdByName.set(p.name.toLowerCase(), String(p.id))
  }

  const listed = await listBlocks(client, base)
  if (!listed.ok) return { success: false, message: `Failed to list device-control blocks: ${listed.err}` }
  const liveByPolicy = new Map<string, LiveBlock>()
  for (const b of listed.items) if (b.policy_id !== undefined && b.policy_id !== null) liveByPolicy.set(String(b.policy_id), b)

  const prior = await loadPriorEntries(ctx)
  const priorByPolicy = new Map(prior.map((e) => [e.name, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const toCreate: Array<{ spec: BlockSpec; policyId: string }> = []

  for (const spec of specs) {
    const policyId = policyIdByName.get(spec.policyName.toLowerCase())
    if (!policyId) {
      failures.push(`${spec.policyName}: policy not found`)
      continue
    }
    const live = liveByPolicy.get(policyId) ?? null
    const priorEntry = priorByPolicy.get(policyId)

    let existed: boolean
    let priorSnap: Record<string, unknown> | undefined
    if (priorEntry) {
      existed = priorEntry.existed
      priorSnap = priorEntry.prior
    } else if (live) {
      existed = true
      priorSnap = snapshotLive(live)
    } else {
      existed = false
      priorSnap = undefined
    }

    if (live?.id && definitionEquals(live, spec)) {
      entries.push({ itemId: spec.itemId, name: policyId, existed, id: live.id, prior: priorSnap })
      continue
    }
    if (live?.id) {
      const updated = await client.put(`${base}/${live.id}`, buildBody(spec, policyId))
      if (!updated.ok) {
        failures.push(`${spec.policyName}: ${cbErrorMessage(updated)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: policyId, existed, id: live.id, prior: priorSnap })
      continue
    }
    toCreate.push({ spec, policyId })
  }

  // Blocks are create-bulk-only: one POST /_bulk with an array of bodies.
  if (toCreate.length) {
    const resp = await client.post(`${base}/_bulk`, toCreate.map((t) => buildBody(t.spec, t.policyId)))
    if (!resp.ok) {
      failures.push(`bulk create: ${cbErrorMessage(resp)}`)
    } else {
      const parsed = parseJson<{ results?: LiveBlock[] } | LiveBlock[]>(resp.body)
      const created = Array.isArray(parsed) ? parsed : parsed?.results ?? []
      const createdByPolicy = new Map<string, LiveBlock>()
      for (const c of created) if (c.policy_id !== undefined && c.policy_id !== null) createdByPolicy.set(String(c.policy_id), c)
      for (const t of toCreate) {
        entries.push({ itemId: t.spec.itemId, name: t.policyId, existed: false, id: createdByPolicy.get(t.policyId)?.id })
      }
    }
  }

  // Reconcile: delete blocks THIS app created previously but no longer declares.
  const declaredPolicies = new Set(entries.map((e) => e.name))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredPolicies.has(p.name)) {
      const del = await client.delete(`${base}/${p.id}`)
      if (!del.ok && del.status !== 404) failures.push(`delete block for policy ${p.name}: ${cbErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some device-control blocks failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} device-control block(s)`, rollbackData: { entries } }
}
