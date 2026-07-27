import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { LiveRole } from '../roles/validate'
import { extractDimensionSpecs, parseJsonObject, type DimensionSpec, type LiveDimension } from './validate'

const ROLES = '/v3/roles'
const childPath = (roleId: string): string => `/beta/roles/${roleId}/dimensions`

export interface RollbackEntry {
  itemId?: string
  roleName: string
  roleId: string
  name: string
  existed: boolean
  dimensionId?: string
  prior?: { name: string; description: string; ownerType: string; ownerId: string; accessProfileIds: string[]; entitlementIds: string[] }
}

function accessProfileRefs(ids: string[]): Array<Record<string, unknown>> {
  return ids.map((id) => ({ type: 'ACCESS_PROFILE', id }))
}
function entitlementRefs(ids: string[]): Array<Record<string, unknown>> {
  return ids.map((id) => ({ type: 'ENTITLEMENT', id }))
}

function createBody(spec: DimensionSpec, membership: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    owner: { type: spec.ownerType, id: spec.ownerId },
    accessProfiles: accessProfileRefs(spec.accessProfileIds),
    entitlements: entitlementRefs(spec.entitlementIds),
  }
  if (Object.keys(membership).length > 0) body.membership = membership
  return body
}

function patchOps(spec: DimensionSpec, membership: Record<string, unknown>): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [
    { op: 'replace', path: '/name', value: spec.name },
    { op: 'replace', path: '/description', value: spec.description },
    { op: 'replace', path: '/owner', value: { type: spec.ownerType, id: spec.ownerId } },
    { op: 'replace', path: '/accessProfiles', value: accessProfileRefs(spec.accessProfileIds) },
    { op: 'replace', path: '/entitlements', value: entitlementRefs(spec.entitlementIds) },
  ]
  if (Object.keys(membership).length > 0) ops.push({ op: 'replace', path: '/membership', value: membership })
  return ops
}

function snapshot(live: LiveDimension): RollbackEntry['prior'] {
  return {
    name: live.name ?? '',
    description: (live.description ?? '') as string,
    ownerType: live.owner?.type ?? 'IDENTITY',
    ownerId: live.owner?.id ?? '',
    accessProfileIds: (live.accessProfiles ?? []).map((a) => a.id ?? '').filter(Boolean),
    entitlementIds: (live.entitlements ?? []).map((e) => e.id ?? '').filter(Boolean),
  }
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

  const specs = extractDimensionSpecs(ctx.canvas).filter((s) => s.name && s.roleName)

  const rolesRes = await client.getAll<LiveRole>(ROLES)
  if (!rolesRes.ok) return { success: false, message: `Failed to list roles: ${iscErrorMessage(rolesRes.lastError!)}` }
  const roleByName = new Map(rolesRes.items.filter((r) => r.name && r.id).map((r) => [r.name!.toLowerCase(), r]))

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  const byRole = new Map<string, DimensionSpec[]>()
  for (const spec of specs) {
    const key = spec.roleName.toLowerCase()
    const list = byRole.get(key) ?? []
    list.push(spec)
    byRole.set(key, list)
  }

  for (const [roleKey, group] of byRole) {
    const role = roleByName.get(roleKey)
    if (!role?.id) {
      for (const s of group) failures.push(`${s.name}: role "${s.roleName}" not found`)
      continue
    }
    const listed = await client.getAll<LiveDimension>(childPath(role.id))
    if (!listed.ok) {
      failures.push(`role "${group[0].roleName}": failed to list dimensions: ${iscErrorMessage(listed.lastError!)}`)
      continue
    }
    const liveByName = new Map(listed.items.filter((d) => d.name).map((d) => [d.name!.toLowerCase(), d]))

    for (const spec of group) {
      const membership = parseJsonObject(spec.membershipRaw)
      if (!membership.ok) {
        failures.push(`${spec.name}: ${membership.error}`)
        continue
      }
      const live = liveByName.get(spec.name.toLowerCase()) ?? null
      if (live?.id) {
        const resp = await client.patch(`${childPath(role.id)}/${live.id}`, patchOps(spec, membership.value))
        if (!resp.ok) {
          failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
          continue
        }
        entries.push({ itemId: spec.itemId, roleName: spec.roleName, roleId: role.id, name: spec.name, existed: true, dimensionId: live.id, prior: snapshot(live) })
      } else {
        const resp = await client.post(childPath(role.id), createBody(spec, membership.value))
        if (!resp.ok) {
          failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
          continue
        }
        const created = parseJson<LiveDimension>(resp.body)
        entries.push({ itemId: spec.itemId, roleName: spec.roleName, roleId: role.id, name: spec.name, existed: false, dimensionId: created?.id })
      }
    }
  }

  // Reconcile: delete dimensions THIS app created but no longer declares.
  const declared = new Set(specs.map((s) => `${s.roleName.toLowerCase()}::${s.name.toLowerCase()}`))
  const keptIds = new Set(entries.map((e) => e.dimensionId).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.dimensionId && !keptIds.has(p.dimensionId) && !declared.has(`${p.roleName.toLowerCase()}::${p.name.toLowerCase()}`)) {
      const resp = await client.delete(`${childPath(p.roleId)}/${p.dimensionId}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some dimensions failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} dimension(s)`, rollbackData: { entries } }
}
