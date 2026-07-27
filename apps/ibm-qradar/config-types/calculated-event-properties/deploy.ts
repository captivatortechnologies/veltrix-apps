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
  extractCalculatedPropertySpecs,
  type CalculatedPropertySpec,
  type LiveCalculatedProperty,
  type LiveOperand,
  type Operand,
} from './validate'

const PATH = '/config/event_sources/custom_properties/calculated_properties'

export interface CalculatedPropertyState {
  name: string
  description: string
  enabled: boolean
  operator: string
  first_operand: LiveOperand
  second_operand: LiveOperand
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: number
  prior?: CalculatedPropertyState
}

function operandBody(op: Operand): LiveOperand {
  return op.type === 'STATIC' ? { type: 'STATIC', numeric_value: Number(op.value) } : { type: 'PROPERTY', property_name: op.value }
}

function bodyOf(spec: CalculatedPropertySpec): CalculatedPropertyState {
  return {
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    operator: spec.operator,
    first_operand: operandBody(spec.firstOperand),
    second_operand: operandBody(spec.secondOperand),
  }
}

function stateOf(live: LiveCalculatedProperty): CalculatedPropertyState {
  return {
    name: live.name ?? '',
    description: live.description ?? '',
    enabled: live.enabled ?? true,
    operator: (live.operator ?? 'ADD').toUpperCase(),
    first_operand: live.first_operand ?? {},
    second_operand: live.second_operand ?? {},
  }
}

function sameOperand(a: LiveOperand, b: LiveOperand): boolean {
  return (a.type ?? '') === (b.type ?? '') && (a.numeric_value ?? null) === (b.numeric_value ?? null) && (a.property_name ?? '') === (b.property_name ?? '')
}

function differs(state: CalculatedPropertyState, body: CalculatedPropertyState): boolean {
  return (
    state.name !== body.name ||
    state.description !== body.description ||
    state.enabled !== body.enabled ||
    state.operator !== body.operator ||
    !sameOperand(state.first_operand, body.first_operand) ||
    !sameOperand(state.second_operand, body.second_operand)
  )
}

export async function listCalculatedProperties(client: QRadarClient): Promise<LiveCalculatedProperty[]> {
  const res = await client.request('GET', PATH, { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveCalculatedProperty[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
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

  const specs = extractCalculatedPropertySpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId as string, p]))
  const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

  const live = await listCalculatedProperties(client)
  const byId = new Map(live.filter((l) => typeof l.id === 'number').map((l) => [l.id as number, l]))
  const byName = new Map(live.filter((l) => l.name).map((l) => [String(l.name).toLowerCase(), l]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItem.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const existing = (priorEntry?.id !== undefined && byId.get(priorEntry.id)) || byName.get(spec.name.toLowerCase())
    const body = bodyOf(spec)

    if (existing && typeof existing.id === 'number') {
      const priorState = stateOf(existing)
      if (differs(priorState, body)) {
        const resp = await client.request('POST', `${PATH}/${existing.id}`, { body })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: existing.id, prior: priorState })
    } else {
      const resp = await client.request('POST', PATH, { body })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveCalculatedProperty>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete calculated properties THIS app created previously but no longer declares.
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter(Boolean))
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && typeof p.id === 'number' && !(p.itemId && declaredItemIds.has(p.itemId)) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.request('DELETE', `${PATH}/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some calculated properties failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} calculated property(ies)`, rollbackData: { entries } }
}
