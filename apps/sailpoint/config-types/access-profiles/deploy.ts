import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractAccessProfileSpecs, type AccessProfileSpec, type LiveAccessProfile } from './validate'

const BASE = '/v3/access-profiles'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; description: string; ownerId: string; enabled: boolean; requestable: boolean; entitlementIds: string[] }
}

function entitlementRefs(ids: string[]): Array<Record<string, unknown>> {
  return ids.map((id) => ({ type: 'ENTITLEMENT', id }))
}

export function createBody(spec: AccessProfileSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    requestable: spec.requestable,
    owner: { type: 'IDENTITY', id: spec.ownerId },
    source: { type: 'SOURCE', id: spec.sourceId },
    entitlements: entitlementRefs(spec.entitlementIds),
  }
}

/** JSON-Patch ops to bring an access profile to the desired state (source is immutable, so not patched). */
export function patchOps(spec: AccessProfileSpec): Array<Record<string, unknown>> {
  return [
    { op: 'replace', path: '/name', value: spec.name },
    { op: 'replace', path: '/description', value: spec.description },
    { op: 'replace', path: '/enabled', value: spec.enabled },
    { op: 'replace', path: '/requestable', value: spec.requestable },
    { op: 'replace', path: '/owner', value: { type: 'IDENTITY', id: spec.ownerId } },
    { op: 'replace', path: '/entitlements', value: entitlementRefs(spec.entitlementIds) },
  ]
}

function liveEntitlementIds(live: LiveAccessProfile): string[] {
  return (live.entitlements ?? []).map((e) => e.id ?? '').filter(Boolean)
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

  const specs = extractAccessProfileSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveAccessProfile>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list access profiles: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveAccessProfile>()
  const liveById = new Map<string, LiveAccessProfile>()
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
      // source is immutable — a same-name profile on a different source must be
      // renamed or deleted by an operator, not silently re-parented.
      if (live.source?.id && spec.sourceId && live.source.id !== spec.sourceId) {
        failures.push(`${spec.name}: an access profile with this name already exists on source "${live.source.id}" — the source is immutable, so rename this one or delete the existing profile first`)
        continue
      }
      const resp = await client.patch(`${BASE}/${live.id}`, patchOps(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: { name: live.name ?? '', description: (live.description ?? '') as string, ownerId: live.owner?.id ?? '', enabled: live.enabled ?? false, requestable: live.requestable ?? true, entitlementIds: liveEntitlementIds(live) } })
    } else {
      const resp = await client.post(BASE, createBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAccessProfile>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete access profiles THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some access profiles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} access profile(s)`, rollbackData: { entries } }
}
