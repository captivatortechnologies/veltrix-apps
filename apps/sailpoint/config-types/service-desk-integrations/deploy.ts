import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractServiceDeskSpecs, parseJsonObject, type LiveServiceDesk, type ServiceDeskSpec } from './validate'

const BASE = '/v3/service-desk-integrations'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  /** Only the round-trippable scalars — `attributes` is secret-bearing and never read back. */
  prior?: { name: string; description: string }
}

export function createBody(spec: ServiceDeskSpec, attributes: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    type: spec.type,
    attributes,
  }
  if (spec.ownerId) body.ownerRef = { type: 'IDENTITY', id: spec.ownerId }
  if (spec.clusterId) body.clusterRef = { type: 'CLUSTER', id: spec.clusterId }
  return body
}

/** JSON-Patch ops — type is immutable; attributes are re-sent so authored secrets apply. */
export function patchOps(spec: ServiceDeskSpec, attributes: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    { op: 'replace', path: '/name', value: spec.name },
    { op: 'replace', path: '/description', value: spec.description },
    { op: 'replace', path: '/attributes', value: attributes },
  ]
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
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const specs = extractServiceDeskSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveServiceDesk>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list service desk integrations: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveServiceDesk>()
  const liveById = new Map<string, LiveServiceDesk>()
  for (const s of listed.items) {
    if (s.name) liveByName.set(s.name.toLowerCase(), s)
    if (s.id) liveById.set(s.id, s)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const parsed = parseJsonObject(spec.attributesRaw)
    if (!parsed.ok) {
      failures.push(`${spec.name}: ${parsed.error}`)
      continue
    }
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.patch(`${BASE}/${live.id}`, patchOps(spec, parsed.value))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: { name: live.name ?? '', description: (live.description ?? '') as string } })
    } else {
      const resp = await client.post(BASE, createBody(spec, parsed.value))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveServiceDesk>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete integrations THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some service desk integrations failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} service desk integration(s)`, rollbackData: { entries } }
}
