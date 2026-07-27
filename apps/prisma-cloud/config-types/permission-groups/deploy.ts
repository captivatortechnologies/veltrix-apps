import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  parseJson,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type PcClient,
} from '../../lib/prismacloud'
import { extractPermissionGroupSpecs, type LivePermissionGroup, type PermissionGroupSpec } from './validate'

const BASE = '/authz/v1/permission_group'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the group existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: {
    name: string
    description: string
    permissionGroupType: string
    acceptAccountGroups: boolean
    acceptResourceLists: boolean
    acceptCodeRepositories: boolean
    features: unknown[]
  }
}

/** A group is manageable only when it is a Custom group. */
function isCustom(g: LivePermissionGroup): boolean {
  return g.custom === true || (g.permissionGroupType ?? '') === 'Custom'
}

export function permissionGroupBody(spec: PermissionGroupSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    permissionGroupType: 'Custom',
    acceptAccountGroups: spec.acceptAccountGroups,
    acceptResourceLists: spec.acceptResourceLists,
    acceptCodeRepositories: spec.acceptCodeRepositories,
    features: spec.features,
  }
}

async function listGroups(client: PcClient): Promise<{ ok: boolean; items: LivePermissionGroup[]; err?: string }> {
  const res = await client.get(BASE)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LivePermissionGroup[]>(res.body) ?? [] }
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
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildPcClient(cred, settings)

  const specs = extractPermissionGroupSpecs(ctx.canvas).filter(
    (s) => s.name && !s.featuresError && s.features.length > 0 && s.permissionGroupType === 'Custom'
  )

  const listed = await listGroups(client)
  if (!listed.ok) return { success: false, message: `Failed to list permission groups: ${listed.err}` }
  // Only Custom groups are matchable — never touch a Default/Internal built-in.
  const liveByName = new Map<string, LivePermissionGroup>()
  const liveById = new Map<string, LivePermissionGroup>()
  for (const g of listed.items) {
    if (!isCustom(g)) continue
    if (g.name) liveByName.set(g.name.toLowerCase(), g)
    if (g.id) liveById.set(g.id, g)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const createdNames: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.put(`${BASE}/${live.id}`, permissionGroupBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        id: live.id,
        prior: {
          name: live.name ?? '',
          description: (live.description ?? '') as string,
          permissionGroupType: live.permissionGroupType ?? 'Custom',
          acceptAccountGroups: live.acceptAccountGroups ?? false,
          acceptResourceLists: live.acceptResourceLists ?? false,
          acceptCodeRepositories: live.acceptCodeRepositories ?? false,
          features: live.features ?? [],
        },
      })
    } else {
      const resp = await client.post(BASE, permissionGroupBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      // Create may echo the id; otherwise resolve it via a re-list by name.
      const created = parseJson<LivePermissionGroup>(resp.body)
      if (created?.id) {
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created.id })
      } else {
        createdNames.push(spec.name)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: priorEntry?.id })
      }
    }
  }

  // Resolve ids for freshly-created groups whose create returned no id.
  if (createdNames.length) {
    const relisted = await listGroups(client)
    if (relisted.ok) {
      const byName = new Map(relisted.items.filter((g) => isCustom(g) && g.name).map((g) => [g.name!.toLowerCase(), g]))
      for (const e of entries) {
        if (!e.existed && !e.id) e.id = byName.get(e.name.toLowerCase())?.id
      }
    }
  }

  // Reconcile: delete groups THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some permission groups failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} permission group(s)`, rollbackData: { entries } }
}
