import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractNpaObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { extractPublisherSpecs, type LivePublisher, type PublisherSpec } from './validate'

const BASE = '/infrastructure/publishers'
const LIST_KEY = 'publishers'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; lbrokerconnect: boolean }
}

export function publisherBody(spec: PublisherSpec): Record<string, unknown> {
  return { name: spec.name, lbrokerconnect: spec.lbrokerconnect }
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

  const specs = extractPublisherSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAllNpa<LivePublisher>(BASE, LIST_KEY)
  if (!listed.ok) return { success: false, message: `Failed to list NPA publishers: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LivePublisher>()
  const liveById = new Map<string, LivePublisher>()
  for (const p of listed.items) {
    if (p.publisher_name) liveByName.set(p.publisher_name.toLowerCase(), p)
    if (p.publisher_id !== undefined) liveById.set(String(p.publisher_id), p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.publisher_id !== undefined) {
      const resp = await client.patch(`${BASE}/${live.publisher_id}`, publisherBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: String(live.publisher_id), prior: { name: live.publisher_name ?? '', lbrokerconnect: live.lbrokerconnect === true } })
    } else {
      const resp = await client.post(BASE, publisherBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractNpaObject<LivePublisher>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.publisher_id !== undefined ? String(created.publisher_id) : undefined })
    }
  }

  // Reconcile: delete publishers THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some NPA publishers failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} NPA publisher(s)`, rollbackData: { entries } }
}
