import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/duo'
import { extractGroupSpecs, type GroupSpec, type LiveGroup } from './validate'

const BASE = '/admin/v1/groups'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the group existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** Duo group_id assigned to the group. */
  groupId?: string
  /** Prior name/desc, captured before an update so rollback can restore them. */
  prior?: { name: string; desc: string }
}

/** Form params for create/modify. desc is always sent so it reconciles. */
export function groupParams(spec: GroupSpec): Record<string, string> {
  return { name: spec.name, desc: spec.desc }
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
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveGroup>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list groups: ${duoErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveGroup>()
  const liveById = new Map<string, LiveGroup>()
  for (const g of listed.items) {
    if (g.name) liveByName.set(g.name.toLowerCase(), g)
    if (g.group_id) liveById.set(g.group_id, g)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    // Prefer the id stored last deploy (rename-safe), else match by name.
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const liveMatch =
      (priorEntry?.groupId ? liveById.get(priorEntry.groupId) : undefined) ??
      liveByName.get(spec.name.toLowerCase()) ??
      null

    if (liveMatch?.group_id) {
      const resp = await client.post(`${BASE}/${liveMatch.group_id}`, groupParams(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${duoErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        groupId: liveMatch.group_id,
        prior: { name: liveMatch.name ?? '', desc: (liveMatch.desc ?? '') as string },
      })
    } else {
      const resp = await client.post(BASE, groupParams(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${duoErrorMessage(resp)}`)
        continue
      }
      const created = resp.response as LiveGroup | null
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, groupId: created?.group_id })
    }
  }

  // Reconcile: delete groups THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.groupId).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.groupId && !keptIds.has(p.groupId) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.groupId}`)
      // Duo group delete is idempotent (200 even if absent).
      if (!resp.ok) failures.push(`delete ${p.name}: ${duoErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some groups failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} group(s)`, rollbackData: { entries } }
}
