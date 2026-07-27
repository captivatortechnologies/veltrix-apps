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
import { indexByLowerName, listTenantRefs, listUserRoles } from '../../lib/lookups'
import { extractResourceRestrictionSpecs, targetKey, type LiveResourceRestriction, type ResourceRestrictionSpec } from './validate'

const PATH = '/config/resource_restrictions'

export interface RestrictionState {
  dataWindow?: number
  executionTime?: number
  recordLimit?: number
}

export interface RollbackEntry {
  itemId?: string
  targetType: string
  targetName: string
  targetKey: string
  existed: boolean
  id?: string
  prior?: RestrictionState
}

export async function listResourceRestrictions(client: QRadarClient): Promise<LiveResourceRestriction[]> {
  const res = await client.request('GET', PATH, { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveResourceRestriction[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

function liveKey(r: LiveResourceRestriction): string | undefined {
  if (typeof r.tenant_id === 'number') return `tenant:${r.tenant_id}`
  if (typeof r.role_id === 'number') return `role:${r.role_id}`
  if (typeof r.user_id === 'number') return `user:${r.user_id}`
  return undefined
}

function bodyOf(spec: ResourceRestrictionSpec, targetId: number): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (spec.dataWindow !== undefined) body.data_window = spec.dataWindow
  if (spec.executionTime !== undefined) body.execution_time = spec.executionTime
  if (spec.recordLimit !== undefined) body.record_limit = spec.recordLimit
  body[spec.targetType === 'tenant' ? 'tenant_id' : 'role_id'] = targetId
  return body
}

function stateOf(r: LiveResourceRestriction): RestrictionState {
  return { dataWindow: r.data_window, executionTime: r.execution_time, recordLimit: r.record_limit }
}

export function bodyFromState(state: RestrictionState): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (state.dataWindow !== undefined) body.data_window = state.dataWindow
  if (state.executionTime !== undefined) body.execution_time = state.executionTime
  if (state.recordLimit !== undefined) body.record_limit = state.recordLimit
  return body
}

function differs(state: RestrictionState, spec: ResourceRestrictionSpec): boolean {
  return (
    (state.dataWindow ?? undefined) !== spec.dataWindow ||
    (state.executionTime ?? undefined) !== spec.executionTime ||
    (state.recordLimit ?? undefined) !== spec.recordLimit
  )
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

  const specs = extractResourceRestrictionSpecs(ctx.canvas).filter((s) => s.targetName)
  const prior = await loadPriorEntries(ctx)

  const [tenants, roles, live] = await Promise.all([listTenantRefs(client), listUserRoles(client), listResourceRestrictions(client)])
  const tenantByName = indexByLowerName(tenants.filter((t) => !t.deleted))
  const roleByName = indexByLowerName(roles)
  const liveByKey = new Map<string, LiveResourceRestriction>()
  for (const r of live) {
    const k = liveKey(r)
    if (k) liveByKey.set(k, r)
  }

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const targetId = spec.targetType === 'tenant' ? tenantByName.get(spec.targetName.toLowerCase()) : roleByName.get(spec.targetName.toLowerCase())
    if (targetId === undefined) {
      failures.push(`${spec.targetType} "${spec.targetName}": target not found`)
      continue
    }
    const resolvedKey = `${spec.targetType}:${targetId}`
    const existing = liveByKey.get(resolvedKey)

    if (existing && existing.id !== undefined) {
      const id = String(existing.id)
      const priorState = stateOf(existing)
      if (differs(priorState, spec)) {
        const resp = await client.request('PUT', `${PATH}/${id}`, { body: bodyOf(spec, targetId) })
        if (!resp.ok) {
          failures.push(`${spec.targetType} "${spec.targetName}": ${qradarErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, targetType: spec.targetType, targetName: spec.targetName, targetKey: targetKey(spec.targetType, spec.targetName), existed: true, id, prior: priorState })
    } else {
      const resp = await client.request('POST', PATH, { body: bodyOf(spec, targetId) })
      if (!resp.ok) {
        failures.push(`${spec.targetType} "${spec.targetName}": ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveResourceRestriction>(resp.body)
      entries.push({ itemId: spec.itemId, targetType: spec.targetType, targetName: spec.targetName, targetKey: targetKey(spec.targetType, spec.targetName), existed: false, id: created?.id !== undefined ? String(created.id) : undefined })
    }
  }

  // Reconcile: delete restrictions THIS app created previously but no longer declares.
  const declaredNameKeys = new Set(specs.map((s) => targetKey(s.targetType, s.targetName)))
  for (const p of prior) {
    if (!p.existed && p.id && !declaredNameKeys.has(p.targetKey)) {
      const resp = await client.request('DELETE', `${PATH}/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.targetType} "${p.targetName}": ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some resource restrictions failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} resource restriction(s)`, rollbackData: { entries } }
}
