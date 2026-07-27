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
import {
  indexByLowerName,
  listLogSourceTypes,
  listProtocolTypes,
  type ProtocolTypeRef,
} from '../../lib/lookups'
import { extractLogSourceSpecs, parseProtocolParameters, type LiveLogSource, type LogSourceSpec } from './validate'

export interface LogSourceBody {
  name: string
  type_id: number
  protocol_type_id: number
  protocol_parameters: Array<{ id: number; name: string; value: string }>
  enabled: boolean
  description: string
  credibility?: number
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  /** the QRadar log source id, for rename-safe matching and delete/restore. */
  id?: number
  prior?: LogSourceBody
}

export async function listLogSources(client: QRadarClient): Promise<LiveLogSource[]> {
  const res = await client.request('GET', '/config/event_sources/log_source_management/log_sources', { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveLogSource[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

function paramMap(list: Array<{ name?: string; value?: string }>): Map<string, string> {
  const m = new Map<string, string>()
  for (const p of list) if (p.name) m.set(p.name.toLowerCase(), p.value ?? '')
  return m
}

/** Build the write body for a spec, resolving the protocol parameter ids from the protocol type. */
function buildBody(spec: LogSourceSpec, typeId: number, protocolId: number, protoDef: ProtocolTypeRef | undefined): { body?: LogSourceBody; error?: string } {
  const { params, error } = parseProtocolParameters(spec.protocolParametersRaw)
  if (error) return { error }
  const defs = protoDef?.parameters ?? []
  const nameToId = new Map(defs.filter((p) => p.name && typeof p.id === 'number').map((p) => [p.name!.toLowerCase(), p.id!]))
  const protocol_parameters: LogSourceBody['protocol_parameters'] = []
  for (const p of params) {
    const id = nameToId.get(p.name.toLowerCase())
    if (id === undefined) return { error: `unknown protocol parameter "${p.name}" for protocol "${spec.protocolName}"` }
    protocol_parameters.push({ id, name: p.name, value: p.value })
  }
  const body: LogSourceBody = { name: spec.name, type_id: typeId, protocol_type_id: protocolId, protocol_parameters, enabled: spec.enabled, description: spec.description }
  if (spec.credibility !== undefined) body.credibility = spec.credibility
  return { body }
}

function priorBodyOf(live: LiveLogSource): LogSourceBody {
  return {
    name: live.name ?? '',
    type_id: live.type_id ?? 0,
    protocol_type_id: live.protocol_type_id ?? 0,
    protocol_parameters: (live.protocol_parameters ?? [])
      .filter((p) => typeof p.id === 'number' && p.name)
      .map((p) => ({ id: p.id as number, name: p.name as string, value: p.value ?? '' })),
    enabled: live.enabled ?? true,
    description: live.description ?? '',
    credibility: live.credibility,
  }
}

function differs(live: LiveLogSource, body: LogSourceBody): boolean {
  if ((live.name ?? '') !== body.name) return true
  if ((live.type_id ?? 0) !== body.type_id) return true
  if ((live.protocol_type_id ?? 0) !== body.protocol_type_id) return true
  if ((live.enabled ?? true) !== body.enabled) return true
  if ((live.description ?? '') !== body.description) return true
  if (body.credibility !== undefined && (live.credibility ?? undefined) !== body.credibility) return true
  const liveParams = paramMap(live.protocol_parameters ?? [])
  const bodyParams = paramMap(body.protocol_parameters)
  if (liveParams.size !== bodyParams.size) return true
  for (const [k, v] of bodyParams) if (liveParams.get(k) !== v) return true
  return false
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

  const specs = extractLogSourceSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId as string, p]))
  const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

  const [types, protocols, live] = await Promise.all([listLogSourceTypes(client), listProtocolTypes(client), listLogSources(client)])
  const typeByName = indexByLowerName(types)
  const protocolByName = indexByLowerName(protocols)
  const protocolById = new Map(protocols.filter((p) => typeof p.id === 'number').map((p) => [p.id as number, p]))
  const byId = new Map(live.filter((l) => typeof l.id === 'number').map((l) => [l.id as number, l]))
  const byName = new Map(live.filter((l) => l.name).map((l) => [String(l.name).toLowerCase(), l]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const typeId = typeByName.get(spec.typeName.toLowerCase())
    if (typeId === undefined) {
      failures.push(`${spec.name}: unknown log source type "${spec.typeName}"`)
      continue
    }
    const protocolId = protocolByName.get(spec.protocolName.toLowerCase())
    if (protocolId === undefined) {
      failures.push(`${spec.name}: unknown protocol "${spec.protocolName}"`)
      continue
    }
    const { body, error } = buildBody(spec, typeId, protocolId, protocolById.get(protocolId))
    if (!body) {
      failures.push(`${spec.name}: ${error}`)
      continue
    }

    const priorEntry = (spec.itemId && priorByItem.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const existing = (priorEntry?.id !== undefined && byId.get(priorEntry.id)) || byName.get(spec.name.toLowerCase())

    if (existing && typeof existing.id === 'number') {
      const priorState = priorBodyOf(existing)
      if (differs(existing, body)) {
        const resp = await client.request('POST', `/config/event_sources/log_source_management/log_sources/${existing.id}`, { body })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: existing.id, prior: priorState })
    } else {
      const resp = await client.request('POST', '/config/event_sources/log_source_management/log_sources', { body })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveLogSource>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete log sources THIS app created previously but no longer declares.
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter(Boolean))
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && typeof p.id === 'number' && !(p.itemId && declaredItemIds.has(p.itemId)) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.request('DELETE', `/config/event_sources/log_source_management/log_sources/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some log sources failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} log source(s)`, rollbackData: { entries } }
}
