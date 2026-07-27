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
import { extractTenantSpecs, type LiveTenant, type TenantSpec } from './validate'

export interface TenantState {
  name: string
  description: string
  eventRateLimit?: number
  flowRateLimit?: number
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  /** the QRadar tenant id, for rename-safe matching and delete/restore. */
  id?: number
  prior?: TenantState
}

export async function listTenants(client: QRadarClient): Promise<LiveTenant[]> {
  const res = await client.request('GET', '/config/access/tenant_management/tenants', { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveTenant[]>(res.body)
  return Array.isArray(parsed) ? parsed.filter((t) => !t.deleted) : []
}

function bodyOf(spec: TenantSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, description: spec.description }
  if (spec.eventRateLimit !== undefined) body.event_rate_limit = spec.eventRateLimit
  if (spec.flowRateLimit !== undefined) body.flow_rate_limit = spec.flowRateLimit
  return body
}

function stateOf(live: LiveTenant): TenantState {
  return { name: live.name ?? '', description: live.description ?? '', eventRateLimit: live.event_rate_limit, flowRateLimit: live.flow_rate_limit }
}

export function bodyFromState(state: TenantState): Record<string, unknown> {
  const body: Record<string, unknown> = { name: state.name, description: state.description }
  if (state.eventRateLimit !== undefined) body.event_rate_limit = state.eventRateLimit
  if (state.flowRateLimit !== undefined) body.flow_rate_limit = state.flowRateLimit
  return body
}

function differs(state: TenantState, spec: TenantSpec): boolean {
  return (
    state.name !== spec.name ||
    state.description !== spec.description ||
    (spec.eventRateLimit !== undefined && state.eventRateLimit !== spec.eventRateLimit) ||
    (spec.flowRateLimit !== undefined && state.flowRateLimit !== spec.flowRateLimit)
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

  const specs = extractTenantSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId as string, p]))
  const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

  const live = await listTenants(client)
  const byId = new Map(live.filter((t) => typeof t.id === 'number').map((t) => [t.id as number, t]))
  const byName = new Map(live.filter((t) => t.name).map((t) => [String(t.name).toLowerCase(), t]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItem.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const existing = (priorEntry?.id !== undefined && byId.get(priorEntry.id)) || byName.get(spec.name.toLowerCase())

    if (existing && typeof existing.id === 'number') {
      const priorState = stateOf(existing)
      if (differs(priorState, spec)) {
        const resp = await client.request('POST', `/config/access/tenant_management/tenants/${existing.id}`, { body: bodyOf(spec) })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: existing.id, prior: priorState })
    } else {
      const resp = await client.request('POST', '/config/access/tenant_management/tenants', { body: bodyOf(spec) })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveTenant>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete tenants THIS app created previously but no longer declares.
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter(Boolean))
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && typeof p.id === 'number' && !(p.itemId && declaredItemIds.has(p.itemId)) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.request('DELETE', `/config/access/tenant_management/tenants/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some tenants failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} tenant(s)`, rollbackData: { entries } }
}
