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
} from '../../lib/graph'
import { assignmentKey, extractRoleAssignmentSpecs, type RoleAssignmentSpec, type LiveRoleAssignment } from './validate'

const BASE = '/roleManagement/directory/roleAssignments'

export interface RollbackEntry {
  itemId?: string
  /** The tuple key identifying the assignment. */
  name: string
  /** true = the tuple already existed and was left untouched (not deleted on rollback). */
  existed: boolean
  id?: string
}

/** POST body — the full assignment tuple. */
export function buildCreateBody(spec: RoleAssignmentSpec): Record<string, unknown> {
  return {
    roleDefinitionId: spec.roleDefinitionId,
    principalId: spec.principalId,
    directoryScopeId: spec.directoryScopeId || '/',
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
  const liveByKey = new Map<string, LiveRoleAssignment>()
  for (const a of listed.items) {
    if (a.id) liveByKey.set(assignmentKey(a), a)
  }

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const key = assignmentKey(spec)
    const live = liveByKey.get(key) ?? null

    if (live?.id) {
      // Exact tuple already exists — nothing to change on an immutable object.
      entries.push({ itemId: spec.itemId, name: key, existed: true, id: live.id })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${key}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveRoleAssignment>(resp.body)
      entries.push({ itemId: spec.itemId, name: key, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete assignments THIS app created previously but no longer declares.
  const declared = new Set(specs.map((s) => assignmentKey(s)))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declared.has(p.name)) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
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
