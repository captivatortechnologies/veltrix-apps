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
import { indexByLowerName, listLogSourceTypes, listProtocolTypes } from '../../lib/lookups'
import { extractLogSourceTypeSpecs, type LiveLogSourceType, type LogSourceTypeSpec } from './validate'

const PATH = '/config/event_sources/log_source_management/log_source_types'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: number
  prior?: { name: string; default_protocol_id?: number }
}

export async function listTypes(client: QRadarClient): Promise<LiveLogSourceType[]> {
  return listLogSourceTypes(client)
}

function bodyOf(spec: LogSourceTypeSpec, defaultProtocolId: number | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name }
  if (defaultProtocolId !== undefined) body.default_protocol_id = defaultProtocolId
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
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const specs = extractLogSourceTypeSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId as string, p]))
  const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

  const [protocols, live] = await Promise.all([listProtocolTypes(client), listTypes(client)])
  const protocolByName = indexByLowerName(protocols)
  const byId = new Map(live.filter((t) => typeof t.id === 'number').map((t) => [t.id as number, t]))
  const byName = new Map(live.filter((t) => t.name).map((t) => [String(t.name).toLowerCase(), t]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    let defaultProtocolId: number | undefined
    if (spec.defaultProtocolName) {
      defaultProtocolId = protocolByName.get(spec.defaultProtocolName.toLowerCase())
      if (defaultProtocolId === undefined) {
        failures.push(`${spec.name}: unknown default protocol "${spec.defaultProtocolName}"`)
        continue
      }
    }

    const priorEntry = (spec.itemId && priorByItem.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const existing = (priorEntry?.id !== undefined && byId.get(priorEntry.id)) || byName.get(spec.name.toLowerCase())

    if (existing && typeof existing.id === 'number') {
      if (existing.internal) {
        failures.push(`${spec.name}: is a built-in log source type and cannot be managed as code`)
        continue
      }
      const priorState = { name: existing.name ?? '', default_protocol_id: existing.default_protocol_id }
      const changed = (existing.name ?? '') !== spec.name || (existing.default_protocol_id ?? undefined) !== defaultProtocolId
      if (changed) {
        const resp = await client.request('POST', `${PATH}/${existing.id}`, { body: bodyOf(spec, defaultProtocolId) })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: existing.id, prior: priorState })
    } else {
      const resp = await client.request('POST', PATH, { body: bodyOf(spec, defaultProtocolId) })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveLogSourceType>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete custom log source types THIS app created previously but no longer declares.
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter(Boolean))
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && typeof p.id === 'number' && !(p.itemId && declaredItemIds.has(p.itemId)) && !declaredNames.has(p.name.toLowerCase())) {
      const target = byId.get(p.id)
      if (target?.internal) continue // never delete a built-in type
      const resp = await client.request('DELETE', `${PATH}/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some log source types failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} log source type(s)`, rollbackData: { entries } }
}
