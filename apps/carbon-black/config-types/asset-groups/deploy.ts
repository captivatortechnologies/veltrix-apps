import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  parseJson,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type CbClient,
} from '../../lib/carbonblack'
import { extractAssetGroupSpecs, type AssetGroupSpec, type LiveAssetGroup } from './validate'

export interface AssetGroupPrior {
  name: string
  description: string
  member_type: string
  query: string
  policy_id: number | string | null
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  /** prior group fields so rollback can restore an updated group. */
  prior?: AssetGroupPrior
}

/** The create/update body for a dynamic asset group. */
export function buildBody(spec: AssetGroupSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    member_type: spec.memberType,
  }
  if (spec.query) body.query = spec.query
  if (spec.policyId) body.policy_id = Number(spec.policyId)
  return body
}

function toPrior(live: LiveAssetGroup): AssetGroupPrior {
  return {
    name: live.name ?? '',
    description: live.description ?? '',
    member_type: live.member_type ?? 'DEVICE',
    query: live.query ?? '',
    policy_id: live.policy_id ?? null,
  }
}

/** Whether a live group already equals the desired spec. */
export function definitionEquals(live: LiveAssetGroup, spec: AssetGroupSpec): boolean {
  if ((live.description ?? '') !== spec.description) return false
  if ((live.query ?? '') !== spec.query) return false
  const livePolicy = live.policy_id === undefined || live.policy_id === null ? '' : String(live.policy_id)
  return livePolicy === spec.policyId
}

async function listGroups(client: CbClient, base: string): Promise<{ ok: boolean; items: LiveAssetGroup[]; err?: string }> {
  const res = await client.get(base)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ results?: LiveAssetGroup[]; groups?: LiveAssetGroup[] } | LiveAssetGroup[]>(res.body)
  const items = Array.isArray(parsed) ? parsed : parsed?.results ?? parsed?.groups ?? []
  return { ok: true, items }
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
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildCbClient(cred, settings)
  const base = client.assetGroupsPath()

  const specs = extractAssetGroupSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await listGroups(client, base)
  if (!listed.ok) return { success: false, message: `Failed to list asset groups: ${listed.err}` }
  const liveByName = new Map<string, LiveAssetGroup>()
  const liveById = new Map<string, LiveAssetGroup>()
  for (const g of listed.items) {
    if (g.name) liveByName.set(g.name.toLowerCase(), g)
    if (g.id) liveById.set(g.id, g)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map<string, RollbackEntry>()
  for (const p of prior) if (p.itemId) priorByItem.set(p.itemId, p)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    // Prefer the prior-stored id (rename-safe) so a renamed group updates in
    // place; otherwise fall back to matching the live set by name.
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live =
      (priorEntry?.id && liveById.get(priorEntry.id)) ||
      liveByName.get(spec.name.toLowerCase()) ||
      null

    if (live?.id) {
      const updated = await client.put(`${base}/${live.id}`, buildBody(spec))
      if (!updated.ok) {
        failures.push(`${spec.name}: ${cbErrorMessage(updated)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: priorEntry ? priorEntry.existed : true, id: live.id, prior: priorEntry?.prior ?? toPrior(live) })
    } else {
      const resp = await client.post(base, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${cbErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAssetGroup>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete groups THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const del = await client.delete(`${base}/${p.id}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${p.name}: ${cbErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some asset groups failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} asset group(s)`, rollbackData: { entries } }
}
