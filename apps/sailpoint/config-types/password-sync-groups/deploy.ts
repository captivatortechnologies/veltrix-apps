import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractPasswordSyncGroupSpecs, type LivePasswordSyncGroup, type PasswordSyncGroupSpec } from './validate'

const BASE = '/v3/password-sync-groups'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; passwordPolicyId: string; sourceIds: string[] }
}

export function buildBody(spec: PasswordSyncGroupSpec): Record<string, unknown> {
  return { name: spec.name, passwordPolicyId: spec.passwordPolicyId, sourceIds: spec.sourceIds }
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

  const specs = extractPasswordSyncGroupSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LivePasswordSyncGroup>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list password sync groups: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LivePasswordSyncGroup>()
  const liveById = new Map<string, LivePasswordSyncGroup>()
  for (const g of listed.items) {
    if (g.name) liveByName.set(g.name.toLowerCase(), g)
    if (g.id) liveById.set(g.id, g)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.put(`${BASE}/${live.id}`, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: { name: live.name ?? '', passwordPolicyId: live.passwordPolicyId ?? '', sourceIds: live.sourceIds ?? [] } })
    } else {
      const resp = await client.post(BASE, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LivePasswordSyncGroup>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete password sync groups THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some password sync groups failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} password sync group(s)`, rollbackData: { entries } }
}
