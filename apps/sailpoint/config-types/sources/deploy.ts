import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractSourceSpecs, parseJsonObject, type LiveSource, type SourceSpec } from './validate'

const BASE = '/v3/sources'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; description: string; ownerId: string; deleteThreshold: number }
}

export function createBody(spec: SourceSpec, connectorAttributes: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    owner: { type: 'IDENTITY', id: spec.ownerId },
    connectorName: spec.connectorName,
    connectorAttributes,
  }
  if (spec.clusterId) body.cluster = { type: 'CLUSTER', id: spec.clusterId }
  if (spec.deleteThreshold > 0) body.deleteThreshold = spec.deleteThreshold
  return body
}

/** JSON-Patch ops for the scalar fields this app owns (secret-bearing
 *  connectorAttributes are replaced on update but not drift-tracked). */
export function patchOps(spec: SourceSpec, connectorAttributes: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    { op: 'replace', path: '/name', value: spec.name },
    { op: 'replace', path: '/description', value: spec.description },
    { op: 'replace', path: '/owner', value: { type: 'IDENTITY', id: spec.ownerId } },
    { op: 'replace', path: '/connectorAttributes', value: connectorAttributes },
    { op: 'replace', path: '/deleteThreshold', value: spec.deleteThreshold },
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

  const specs = extractSourceSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveSource>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list sources: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveSource>()
  const liveById = new Map<string, LiveSource>()
  for (const s of listed.items) {
    if (s.name) liveByName.set(s.name.toLowerCase(), s)
    if (s.id) liveById.set(s.id, s)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const parsed = parseJsonObject(spec.connectorAttributesRaw)
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
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: { name: live.name ?? '', description: (live.description ?? '') as string, ownerId: live.owner?.id ?? '', deleteThreshold: live.deleteThreshold ?? 0 } })
    } else {
      const resp = await client.post(BASE, createBody(spec, parsed.value))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveSource>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete sources THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some sources failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} source(s)`, rollbackData: { entries } }
}
