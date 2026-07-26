import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  parseJson,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { extractTagSpecs, type LiveTag, type TagSpec } from './validate'

const BASE = '/deviceclassification/tags'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; description: string }
}

export function tagBody(spec: TagSpec): Record<string, unknown> {
  return { name: spec.name, description: spec.description }
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
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractTagSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveTag>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list device classification tags: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveTag>()
  const liveById = new Map<string, LiveTag>()
  for (const t of listed.items) {
    if (t.name) liveByName.set(t.name.toLowerCase(), t)
    if (t.id !== undefined) liveById.set(String(t.id), t)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id !== undefined) {
      const resp = await client.put(`${BASE}/${live.id}`, tagBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: String(live.id), prior: { name: live.name ?? '', description: (live.description ?? '') as string } })
    } else {
      const resp = await client.post(BASE, tagBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveTag>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id !== undefined ? String(created.id) : undefined })
    }
  }

  // Reconcile: delete tags THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some tags failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} device classification tag(s)`, rollbackData: { entries } }
}
