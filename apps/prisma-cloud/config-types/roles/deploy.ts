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
import { extractRoleSpecs, type LiveRole, type RoleSpec } from './validate'

const BASE = '/user/role'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the role existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: { name: string; roleType: string; description: string; accountGroupIds: string[]; resourceListIds: string[]; restrictDismissalAccess: boolean }
}

export function roleBody(spec: RoleSpec): Record<string, unknown> {
  return {
    name: spec.name,
    roleType: spec.roleType,
    description: spec.description,
    accountGroupIds: spec.accountGroupIds,
    resourceListIds: spec.resourceListIds,
    restrictDismissalAccess: spec.restrictDismissalAccess,
  }
}

async function listRoles(client: PcClient): Promise<{ ok: boolean; items: LiveRole[]; err?: string }> {
  const res = await client.get(BASE)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LiveRole[]>(res.body) ?? [] }
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

  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name && s.roleType)

  const listed = await listRoles(client)
  if (!listed.ok) return { success: false, message: `Failed to list roles: ${listed.err}` }
  const liveByName = new Map<string, LiveRole>()
  const liveById = new Map<string, LiveRole>()
  for (const r of listed.items) {
    if (r.name) liveByName.set(r.name.toLowerCase(), r)
    if (r.id) liveById.set(r.id, r)
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
      const resp = await client.put(`${BASE}/${live.id}`, roleBody(spec))
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
          roleType: live.roleType ?? '',
          description: (live.description ?? '') as string,
          accountGroupIds: live.accountGroupIds ?? [],
          resourceListIds: live.resourceListIds ?? [],
          restrictDismissalAccess: live.restrictDismissalAccess ?? false,
        },
      })
    } else {
      // POST /user/role — the id is resolved after by re-listing (by name).
      const resp = await client.post(BASE, roleBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      createdNames.push(spec.name)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: priorEntry?.id })
    }
  }

  // Resolve ids for freshly-created roles.
  if (createdNames.length) {
    const relisted = await listRoles(client)
    if (relisted.ok) {
      const byName = new Map(relisted.items.filter((r) => r.name).map((r) => [r.name!.toLowerCase(), r]))
      for (const e of entries) {
        if (!e.existed && !e.id) e.id = byName.get(e.name.toLowerCase())?.id
      }
    }
  }

  // Reconcile: delete roles THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some roles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} role(s)`, rollbackData: { entries } }
}
