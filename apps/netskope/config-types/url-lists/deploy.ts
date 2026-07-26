import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  parseJson,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type NetskopeClient,
} from '../../lib/netskope'
import { extractUrlListSpecs, type LiveUrlList, type UrlListSpec } from './validate'

const BASE = '/policy/urllist'
const DEPLOY = '/policy/urllist/deploy'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the list existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** Netskope url-list id. */
  id?: string
  /** Prior name/urls/type, captured before an update so rollback can restore it. */
  prior?: { name: string; urls: string[]; type: string }
}

export function buildBody(spec: UrlListSpec): Record<string, unknown> {
  return { name: spec.name, data: { urls: spec.urls, type: spec.type } }
}

function snapshotLive(live: LiveUrlList): { name: string; urls: string[]; type: string } {
  return { name: live.name ?? '', urls: live.data?.urls ?? [], type: live.data?.type ?? 'exact' }
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

/** Apply all pending url-list changes on the tenant (tenant-global). */
export async function applyPending(client: NetskopeClient, failures: string[]): Promise<void> {
  const resp = await client.post(DEPLOY, {})
  if (!resp.ok) failures.push(`deploy (apply pending): ${netskopeErrorMessage(resp)}`)
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractUrlListSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveUrlList>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list URL lists: ${netskopeErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveUrlList>()
  const liveById = new Map<string, LiveUrlList>()
  for (const l of listed.items) {
    if (l.name) liveByName.set(l.name.toLowerCase(), l)
    if (l.id !== undefined) liveById.set(String(l.id), l)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  let changed = false

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id !== undefined) {
      const resp = await client.put(`${BASE}/${liveMatch.id}`, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      changed = true
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: String(liveMatch.id), prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      changed = true
      const created = parseJson<LiveUrlList>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id !== undefined ? String(created.id) : undefined })
    }
  }

  // Reconcile: delete URL lists THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
      else changed = true
    }
  }

  // Staged changes only take effect after a deploy (applies all pending
  // url-list changes on the tenant).
  if (changed) await applyPending(client, failures)

  if (failures.length) {
    return { success: false, message: `Some URL lists failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} URL list(s)`, rollbackData: { entries } }
}
