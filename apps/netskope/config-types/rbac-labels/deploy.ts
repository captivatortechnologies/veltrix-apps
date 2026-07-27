import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  parseJson,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { extractLabelSpecs, type LabelSpec, type LiveLabel } from './validate'

const BASE = '/rbac/labels'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; color: string }
}

export function labelBody(spec: LabelSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name }
  if (spec.color) body.color = spec.color
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
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractLabelSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveLabel>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list RBAC labels: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveLabel>()
  const liveById = new Map<string, LiveLabel>()
  for (const l of listed.items) {
    if (l.name) liveByName.set(l.name.toLowerCase(), l)
    if (l.id !== undefined) liveById.set(String(l.id), l)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id !== undefined) {
      const resp = await client.patch(`${BASE}/${live.id}`, labelBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: String(live.id), prior: { name: live.name ?? '', color: (live.color ?? '') as string } })
    } else {
      const resp = await client.post(BASE, labelBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveLabel>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id !== undefined ? String(created.id) : undefined })
    }
  }

  // Reconcile: delete labels THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some labels failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} RBAC label(s)`, rollbackData: { entries } }
}
