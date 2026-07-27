import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractSourceAppSpecs, type LiveSourceApp, type SourceAppSpec } from './validate'

const BASE = '/beta/source-apps'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; description: string; matchAllAccounts: boolean }
}

export function createBody(spec: SourceAppSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    accountSource: { id: spec.accountSourceId, type: 'SOURCE' },
    matchAllAccounts: spec.matchAllAccounts,
  }
}

/** JSON-Patch ops — the account source is immutable and never patched. */
export function patchOps(spec: SourceAppSpec): Array<Record<string, unknown>> {
  return [
    { op: 'replace', path: '/name', value: spec.name },
    { op: 'replace', path: '/description', value: spec.description },
    { op: 'replace', path: '/matchAllAccounts', value: spec.matchAllAccounts },
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

  const specs = extractSourceAppSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveSourceApp>(`${BASE}/all`)
  if (!listed.ok) return { success: false, message: `Failed to list source apps: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveSourceApp>()
  const liveById = new Map<string, LiveSourceApp>()
  for (const a of listed.items) {
    if (a.name) liveByName.set(a.name.toLowerCase(), a)
    if (a.id) liveById.set(a.id, a)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.patch(`${BASE}/${live.id}`, patchOps(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: { name: live.name ?? '', description: (live.description ?? '') as string, matchAllAccounts: live.matchAllAccounts ?? false } })
    } else {
      const resp = await client.post(BASE, createBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveSourceApp>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete source apps THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some source apps failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} source app(s)`, rollbackData: { entries } }
}
