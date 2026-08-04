// A unifiedRoleAssignment is IMMUTABLE — Graph exposes only List/Get/Create/Delete,
// there is NO PATCH. So deploy never updates in place: a declared tuple that already
// exists is a no-op, and a "changed" assignment is really a different tuple that gets
// created (its predecessor, if this app made it, is deleted by reconcile). This app
// manages the exact declared tuples (roleDefinitionId + principalId + directoryScopeId):
// create the missing ones, and delete only the ones it previously created.
import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type GraphClient,
} from '../../lib/graph'
import { assignmentKey, extractRoleAssignmentSpecs, type RoleAssignmentSpec, type LiveRoleAssignment } from './validate'
import { buildRoleNameToId, resolveRef } from '../lib/nameMaps'
import { buildPrincipalNameMaps, resolvePrincipal, type PrincipalNameMaps } from '../lib/principals'
import { buildDirectoryScopeNameMaps, resolveDirectoryScope, type DirectoryScopeNameMaps } from '../lib/directoryScope'

const BASE = '/roleManagement/directory/roleAssignments'

export interface RollbackEntry {
  itemId?: string
  /** The tuple key identifying the assignment. */
  name: string
  /** true = the tuple already existed and was left untouched (not deleted on rollback). */
  existed: boolean
  id?: string
}

/** A tuple with every reference already resolved to its live Graph id/scope string. */
export interface ResolvedAssignment {
  roleDefinitionId: string
  principalId: string
  directoryScopeId: string
}

/** POST body — the full assignment tuple, already resolved. */
export function buildCreateBody(resolved: ResolvedAssignment): Record<string, unknown> {
  return {
    roleDefinitionId: resolved.roleDefinitionId,
    principalId: resolved.principalId,
    directoryScopeId: resolved.directoryScopeId || '/',
  }
}

interface NameMaps {
  role: Map<string, string>
  principal: PrincipalNameMaps
  scope: DirectoryScopeNameMaps
}

async function buildNameMaps(client: GraphClient): Promise<NameMaps> {
  const [role, principal, scope] = await Promise.all([
    buildRoleNameToId(client),
    buildPrincipalNameMaps(client),
    buildDirectoryScopeNameMaps(client),
  ])
  return { role, principal, scope }
}

/**
 * Resolve one spec's role/principal/scope references. A picker-selected
 * value passes straight through; a hand-typed display name resolves via the
 * live maps built once per deploy/drift run (see ../lib/nameMaps,
 * ../lib/principals, ../lib/directoryScope). Returns the unresolved
 * reference(s) as `missing` when any lookup fails.
 */
export function resolveAssignment(
  spec: Pick<RoleAssignmentSpec, 'roleDefinitionId' | 'principalId' | 'directoryScopeId'>,
  maps: NameMaps
): { resolved: ResolvedAssignment; missing: string[] } {
  const role = resolveRef(spec.roleDefinitionId, maps.role)
  const principal = resolvePrincipal(spec.principalId, maps.principal)
  const scope = resolveDirectoryScope(spec.directoryScopeId, maps.scope)
  const missing = [
    ...(role.missing ? [spec.roleDefinitionId] : []),
    ...(principal.missing ? [spec.principalId] : []),
    ...(scope.missing ? [scope.missing] : []),
  ]
  return {
    resolved: { roleDefinitionId: role.id, principalId: principal.id, directoryScopeId: scope.scope || '/' },
    missing,
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
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractRoleAssignmentSpecs(ctx.canvas).filter((s) => s.roleDefinitionId && s.principalId)

  const listed = await client.getAll<LiveRoleAssignment>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list role assignments: ${graphErrorMessage(listed.lastError!)}` }
  }
  // A truncated listing would mis-read an existing tuple as "missing" and POST a
  // duplicate — fail safe instead of corrupting privileged role assignments.
  if (listed.truncated) {
    return {
      success: false,
      message: `Cannot safely reconcile role assignments: the directory returned more than ~${listed.items.length} assignments and the listing was truncated, so a declared assignment could be mis-detected as missing and duplicated. Reduce the number of managed assignments or contact support.`,
    }
  }
  const liveByKey = new Map<string, LiveRoleAssignment>()
  for (const a of listed.items) {
    if (a.id) liveByKey.set(assignmentKey(a), a)
  }

  // Resolve every spec's role/principal/scope references once, using name
  // maps built once for the whole deploy (mirrors conditional-access-policies).
  const maps = await buildNameMaps(client)

  const prior = await loadPriorEntries(ctx)
  const priorByKey = new Map(prior.map((e) => [e.name, e]))
  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const declared = new Set<string>()

  for (const spec of specs) {
    const { resolved, missing } = resolveAssignment(spec, maps)
    if (missing.length) {
      const label = spec.label || `${spec.roleDefinitionId} -> ${spec.principalId}`
      failures.push(`${label}: unknown target(s) ${missing.join(', ')} — create/verify them first or fix the name`)
      continue
    }

    const key = assignmentKey(resolved)
    declared.add(key)
    const live = liveByKey.get(key) ?? null

    if (live?.id) {
      // Exact tuple already exists — nothing to change on an immutable object.
      // Sticky provenance: keep existed:false if a prior deploy created this
      // assignment, so a later removal still revokes it (a privileged grant must
      // not leak just because it survived one intervening deploy).
      entries.push({
        itemId: spec.itemId,
        name: key,
        existed: priorByKey.get(key)?.existed === false ? false : true,
        id: live.id,
      })
    } else {
      const resp = await client.post(BASE, buildCreateBody(resolved))
      if (!resp.ok) {
        failures.push(`${key}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveRoleAssignment>(resp.body)
      entries.push({ itemId: spec.itemId, name: key, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete assignments THIS app created previously but no longer
  // declares. A spec whose reference failed to resolve THIS run is still
  // "declared" by canvas item — protected via itemId — so a transient lookup
  // failure (e.g. a typo, or the live directory being briefly unreachable for
  // one lookup) never deletes a privileged assignment the user still intends
  // to keep; only removing the item from the canvas does.
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter((v): v is string => Boolean(v)))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (p.existed || !p.id || keptIds.has(p.id)) continue
    if (declared.has(p.name) || (p.itemId && declaredItemIds.has(p.itemId))) continue
    const resp = await client.delete(`${BASE}/${p.id}`)
    if (!resp.ok && resp.status !== 404) {
      failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some role assignments failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} role assignment(s)`,
    rollbackData: { entries },
  }
}
