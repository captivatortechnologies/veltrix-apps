import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  parseJson,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/carbonblack'
import {
  extractApprovalSpecs,
  liveNaturalKey,
  naturalKey,
  type ApprovalSpec,
  type LiveApproval,
} from './validate'

export interface RollbackEntry {
  itemId?: string
  /** the natural key (vendor|product|serial). */
  name: string
  existed: boolean
  id?: string
  /** the original pre-management approval body, so rollback can restore it. */
  prior?: Record<string, unknown>
}

export function buildBody(spec: ApprovalSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (spec.approvalName) body.approval_name = spec.approvalName
  if (spec.notes) body.notes = spec.notes
  if (spec.vendorId) body.vendor_id = spec.vendorId
  if (spec.productId) body.product_id = spec.productId
  if (spec.serialNumber) body.serial_number = spec.serialNumber
  return body
}

export function snapshotLive(live: LiveApproval): Record<string, unknown> {
  const b: Record<string, unknown> = {}
  for (const k of ['approval_name', 'notes', 'vendor_id', 'product_id', 'serial_number'] as const) {
    if (live[k] !== undefined) b[k] = live[k]
  }
  return b
}

/** Whether a live approval already equals the desired spec (natural key matches). */
export function definitionEquals(live: LiveApproval, spec: ApprovalSpec): boolean {
  return (live.approval_name ?? '') === spec.approvalName && (live.notes ?? '') === spec.notes
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
  const base = client.deviceControlPath('approvals')

  const specs = extractApprovalSpecs(ctx.canvas).filter((s) => s.approvalName && (s.vendorId || s.productId || s.serialNumber))

  const listed = await client.searchAllAt<LiveApproval>(base, {})
  if (!listed.ok) return { success: false, message: `Failed to list device-control approvals: ${cbErrorMessage(listed.lastError!)}` }
  const liveByKey = new Map<string, LiveApproval>()
  for (const a of listed.items) liveByKey.set(liveNaturalKey(a), a)

  const prior = await loadPriorEntries(ctx)
  const priorByKey = new Map(prior.map((e) => [e.name, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const toCreate: ApprovalSpec[] = []

  for (const spec of specs) {
    const key = naturalKey(spec)
    const live = liveByKey.get(key) ?? null
    const priorEntry = priorByKey.get(key)

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
      entries.push({ itemId: spec.itemId, name: key, existed, id: live.id, prior: priorSnap })
      continue
    }
    if (live?.id) {
      const updated = await client.put(`${base}/${live.id}`, buildBody(spec))
      if (!updated.ok) {
        failures.push(`${spec.approvalName}: ${cbErrorMessage(updated)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: key, existed, id: live.id, prior: priorSnap })
      continue
    }
    // No live match — queue for the bulk create.
    toCreate.push(spec)
  }

  // Approvals are create-bulk-only: one POST /_bulk with an array of bodies.
  if (toCreate.length) {
    const resp = await client.post(`${base}/_bulk`, toCreate.map(buildBody))
    if (!resp.ok) {
      failures.push(`bulk create: ${cbErrorMessage(resp)}`)
    } else {
      const parsed = parseJson<{ results?: LiveApproval[] } | LiveApproval[]>(resp.body)
      const created = Array.isArray(parsed) ? parsed : parsed?.results ?? []
      const createdByKey = new Map<string, LiveApproval>()
      for (const c of created) createdByKey.set(liveNaturalKey(c), c)
      for (const spec of toCreate) {
        const key = naturalKey(spec)
        entries.push({ itemId: spec.itemId, name: key, existed: false, id: createdByKey.get(key)?.id })
      }
    }
  }

  // Reconcile: delete approvals THIS app created previously but no longer declares.
  const declaredKeys = new Set(specs.map((s) => naturalKey(s)))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredKeys.has(p.name)) {
      const del = await client.delete(`${base}/${p.id}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${p.name}: ${cbErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some device-control approvals failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} device-control approval(s)`, rollbackData: { entries } }
}
