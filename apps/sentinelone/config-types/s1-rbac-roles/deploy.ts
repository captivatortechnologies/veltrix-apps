import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildS1Client,
  MISSING_SCOPE_MESSAGE,
  s1ErrorMessage,
  s1Result,
  type S1Client,
} from '../../lib/s1'
import { extractRbacRoleSpecs, roleKey, setNestedPath, type LiveRbacRole, type LiveRbacRoleDetail, type RbacRoleSpec } from './validate'

export interface RbacRoleRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** The role's full pre-deploy detail (name/description/permissions), for restore. */
  prior?: LiveRbacRoleDetail
}

/**
 * Deploy SentinelOne RBAC custom roles via the Management API (`/rbac/roles`).
 *
 * Identity is the role `name` at the configured scope: list /rbac/roles, match
 * on the (case-insensitive) name, then either:
 *   - update an EXISTING role — GET /rbac/role/{id} for its current full
 *     permissions, merge in the declared dot-path overrides, PUT the merged
 *     role back; or
 *   - create a NEW role — GET /rbac/role (no id) for the scope's new-role
 *     PERMISSION TEMPLATE, merge in the declared overrides, POST the merged
 *     role.
 * This mirrors the existing s1-agent-policy config type's read-merge-write
 * pattern exactly (this app does not hardcode SentinelOne's permission
 * taxonomy — it is tenant/SKU-specific and discovered live). Scope is carried
 * in the request body's `filter`, and an existing role's id is carried inside
 * `data` — the same request shape this app already uses for /exclusions.
 *
 * Sources: Celerium/SentinelOne-PowerShellWrapper `Get-SentinelOneRBACRoles`
 * (GET /rbac/roles, GET /rbac/role/{role_id}) and
 * `Get-SentinelOneRBACRoleTemplate` (GET /rbac/role — confirms the "template
 * for a new role" semantics). See config-types/s1-rbac-roles/validate.ts for
 * the full citation.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built
  if (!client.hasScope) return { success: false, message: MISSING_SCOPE_MESSAGE }

  const sf = client.scopeFilter()
  if (sf.error || !sf.filter) return { success: false, message: sf.error ?? MISSING_SCOPE_MESSAGE }
  const filter = sf.filter

  const specs = extractRbacRoleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RbacRoleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listRbacRoles(client)
    const byKey = new Map(existing.filter((r) => r.name).map((r) => [roleKey(r.name as string), r]))

    for (const spec of specs) {
      const label = spec.name
      const key = roleKey(spec.name)
      const live = byKey.get(key)

      if (live && live.id) {
        const detail = await getRoleDetail(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior: detail })
        const merged = mergePermissions(detail, spec)
        const res = await client.request('PUT', '/rbac/roles', {
          body: { filter, data: { id: live.id, name: spec.name, description: spec.description ?? '', permissions: merged } },
        })
        if (!res.ok) throw new Error(`Failed to update RBAC role "${label}": ${s1ErrorMessage(res)}`)
      } else {
        const template = await getRoleTemplate(client)
        const merged = mergePermissions(template, spec)
        const res = await client.request('POST', '/rbac/roles', {
          body: { filter, data: { name: spec.name, description: spec.description ?? '', permissions: merged } },
        })
        if (!res.ok) throw new Error(`Failed to create RBAC role "${label}": ${s1ErrorMessage(res)}`)
        const created = firstResult(s1Result<LiveRbacRole | LiveRbacRole[]>(res))
        if (!created?.id) throw new Error(`RBAC role "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} RBAC role(s) to ${consoleUrl} (${client.currentScope} scope): ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `RBAC role deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all RBAC roles at the configured scope (no permissions); throws on a non-OK response. */
export async function listRbacRoles(client: S1Client): Promise<LiveRbacRole[]> {
  const sq = client.scopeQuery()
  if (sq.error || !sq.query) throw new Error(sq.error ?? 'scope not configured')
  const res = await client.getAll<LiveRbacRole>('/rbac/roles', sq.query)
  if (!res.ok) {
    throw new Error(`Failed to list RBAC roles: ${s1ErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET /rbac/role/{id} — a role's current full detail, including permissions. */
export async function getRoleDetail(client: S1Client, id: string): Promise<LiveRbacRoleDetail> {
  const sq = client.scopeQuery()
  if (sq.error || !sq.query) throw new Error(sq.error ?? 'scope not configured')
  const res = await client.request('GET', `/rbac/role/${encodeURIComponent(id)}`, { query: sq.query })
  if (!res.ok) throw new Error(`Failed to read RBAC role detail: ${s1ErrorMessage(res)}`)
  return s1Result<LiveRbacRoleDetail>(res) ?? {}
}

/** GET /rbac/role (no id) — the scope's permission template for a brand-new role. */
export async function getRoleTemplate(client: S1Client): Promise<LiveRbacRoleDetail> {
  const sq = client.scopeQuery()
  if (sq.error || !sq.query) throw new Error(sq.error ?? 'scope not configured')
  const res = await client.request('GET', '/rbac/role', { query: sq.query })
  if (!res.ok) throw new Error(`Failed to read the RBAC role template: ${s1ErrorMessage(res)}`)
  return s1Result<LiveRbacRoleDetail>(res) ?? {}
}

/**
 * Merge a spec's declared dot-path permission overrides into a baseline
 * (an existing role's detail, or the new-role template). The baseline's
 * `permissions` sub-object is preferred; if the API instead returns the
 * permission tree at the top level (no `permissions` wrapper), the whole
 * object is used as the base — this app defends against either shape rather
 * than assume one.
 */
export function mergePermissions(baseline: LiveRbacRoleDetail, spec: RbacRoleSpec): Record<string, unknown> {
  const merged: Record<string, unknown> = JSON.parse(JSON.stringify(permissionsOf(baseline)))
  for (const [permKey, value] of Object.entries(spec.permissions)) setNestedPath(merged, permKey, value)
  return merged
}

/**
 * The permission tree of a role detail/template object: its `permissions`
 * sub-object when present, else the whole object (defends against either API
 * shape — see the `mergePermissions` doc comment). Exported so rollback.ts
 * restores a prior role using the identical extraction rule.
 */
export function permissionsOf(detail: LiveRbacRoleDetail): Record<string, unknown> {
  const base = detail.permissions && typeof detail.permissions === 'object' ? detail.permissions : detail
  return (base ?? {}) as Record<string, unknown>
}

/** POST /rbac/roles may return the created object or an array; normalize to the first. */
function firstResult(result: LiveRbacRole | LiveRbacRole[] | null): LiveRbacRole | null {
  if (!result) return null
  return Array.isArray(result) ? result[0] ?? null : result
}
