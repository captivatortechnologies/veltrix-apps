import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractRoleSpecs, type LiveRole, type RoleSpec } from './validate'

const BASE = '/v3/roles'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; description: string; ownerId: string; enabled: boolean; requestable: boolean; accessProfileIds: string[] }
}

function accessProfileRefs(ids: string[]): Array<Record<string, unknown>> {
  return ids.map((id) => ({ type: 'ACCESS_PROFILE', id }))
}

export function createBody(spec: RoleSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    requestable: spec.requestable,
    owner: { type: 'IDENTITY', id: spec.ownerId },
    accessProfiles: accessProfileRefs(spec.accessProfileIds),
  }
}

/** JSON-Patch ops to bring a role to the desired name/description/owner/access. */
export function patchOps(spec: RoleSpec): Array<Record<string, unknown>> {
  return [
    { op: 'replace', path: '/name', value: spec.name },
    { op: 'replace', path: '/description', value: spec.description },
    { op: 'replace', path: '/enabled', value: spec.enabled },
    { op: 'replace', path: '/requestable', value: spec.requestable },
    { op: 'replace', path: '/owner', value: { type: 'IDENTITY', id: spec.ownerId } },
    { op: 'replace', path: '/accessProfiles', value: accessProfileRefs(spec.accessProfileIds) },
  ]
}

function liveAccessProfileIds(live: LiveRole): string[] {
  return (live.accessProfiles ?? []).map((a) => a.id ?? '').filter(Boolean)
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

  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveRole>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list roles: ${iscErrorMessage(listed.lastError!)}` }
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

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.patch(`${BASE}/${live.id}`, patchOps(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: { name: live.name ?? '', description: (live.description ?? '') as string, ownerId: live.owner?.id ?? '', enabled: live.enabled ?? false, requestable: live.requestable ?? true, accessProfileIds: liveAccessProfileIds(live) } })
    } else {
      const resp = await client.post(BASE, createBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveRole>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete roles THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some roles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} role(s)`, rollbackData: { entries } }
}
