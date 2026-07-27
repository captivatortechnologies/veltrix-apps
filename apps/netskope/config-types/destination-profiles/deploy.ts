import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractProfileObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type NetskopeClient,
} from '../../lib/netskope'
import type { LiveLabel } from '../rbac-labels/validate'
import {
  extractDestinationProfileSpecs,
  liveDestinationProfileId,
  type DestinationProfileSpec,
  type LiveDestinationProfile,
} from './validate'

const BASE = '/profiles/destinations'
const LABELS_BASE = '/rbac/labels'

export interface DestinationProfileSnapshot {
  name: string
  type: string
  description: string
  values: string[]
  label_ids: string[]
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: DestinationProfileSnapshot
}

export function destinationProfileBody(spec: DestinationProfileSpec, labelIds: string[]): Record<string, unknown> {
  return {
    name: spec.name,
    type: spec.type,
    description: spec.description,
    values: spec.values,
    label_ids: labelIds,
  }
}

function snapshotLive(live: LiveDestinationProfile): DestinationProfileSnapshot {
  return {
    name: live.name ?? '',
    type: live.type ?? 'insensitive',
    description: live.description ?? '',
    values: live.values ?? [],
    label_ids: (live.label_ids ?? []).map((v) => String(v)),
  }
}

/** Resolve declared RBAC label names/ids to label ids using the live labels. */
function resolveLabels(
  entries: string[],
  byName: Map<string, string>,
  byId: Set<string>
): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = []
  const unresolved: string[] = []
  for (const entry of entries) {
    const id = byId.has(entry) ? entry : byName.get(entry.toLowerCase())
    if (id) resolved.push(id)
    else unresolved.push(entry)
  }
  return { resolved, unresolved }
}

async function loadLabelMaps(client: NetskopeClient): Promise<{ ok: boolean; byName: Map<string, string>; byId: Set<string>; error?: string }> {
  const byName = new Map<string, string>()
  const byId = new Set<string>()
  const listed = await client.getAll<LiveLabel>(LABELS_BASE)
  if (!listed.ok) return { ok: false, byName, byId, error: netskopeErrorMessage(listed.lastError!) }
  for (const l of listed.items) {
    if (l.id === undefined || l.id === null) continue
    const id = String(l.id)
    byId.add(id)
    if (l.name) byName.set(l.name.toLowerCase(), id)
  }
  return { ok: true, byName, byId }
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

  const specs = extractDestinationProfileSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveDestinationProfile>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list destination profiles: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveDestinationProfile>()
  const liveById = new Map<string, LiveDestinationProfile>()
  for (const p of listed.items) {
    if (p.name) liveByName.set(p.name.toLowerCase(), p)
    const id = liveDestinationProfileId(p)
    if (id) liveById.set(id, p)
  }

  const labelMaps = await loadLabelMaps(client)
  if (!labelMaps.ok) return { success: false, message: `Failed to list RBAC labels: ${labelMaps.error}` }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const { resolved, unresolved } = resolveLabels(spec.labels, labelMaps.byName, labelMaps.byId)
    if (unresolved.length) {
      failures.push(`${spec.name}: unknown RBAC label(s): ${unresolved.join(', ')}`)
      continue
    }

    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveDestinationProfileId(live) : undefined

    if (liveId) {
      const resp = await client.patch(`${BASE}/${liveId}`, destinationProfileBody(spec, resolved))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, destinationProfileBody(spec, resolved))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractProfileObject<LiveDestinationProfile>(resp.body)
      const newId = created ? liveDestinationProfileId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete destination profiles THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some destination profiles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} destination profile(s)`, rollbackData: { entries } }
}
