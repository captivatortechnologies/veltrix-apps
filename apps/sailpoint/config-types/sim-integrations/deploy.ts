import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractSimIntegrationSpecs, parseJsonObject, type LiveSimIntegration, type SimIntegrationSpec } from './validate'

const BASE = '/beta/sim-integrations'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  /** Round-trippable scalars only — `attributes` is secret-bearing and never read back. */
  prior?: { name: string; description: string; sources: string[] }
}

export function createBody(spec: SimIntegrationSpec, attributes: Record<string, unknown>): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    type: spec.type,
    cluster: spec.cluster,
    sources: spec.sources,
    attributes,
  }
}

export function patchOps(spec: SimIntegrationSpec, attributes: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    { op: 'replace', path: '/name', value: spec.name },
    { op: 'replace', path: '/description', value: spec.description },
    { op: 'replace', path: '/sources', value: spec.sources },
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

  const specs = extractSimIntegrationSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveSimIntegration>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list SIM integrations: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveSimIntegration>()
  const liveById = new Map<string, LiveSimIntegration>()
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
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: { name: live.name ?? '', description: (live.description ?? '') as string, sources: live.sources ?? [] } })
    } else {
      const resp = await client.post(BASE, createBody(spec, parsed.value))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveSimIntegration>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete SIM integrations THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some SIM integrations failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} SIM integration(s)`, rollbackData: { entries } }
}
