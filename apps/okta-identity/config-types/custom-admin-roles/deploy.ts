import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractRoleSpecs,
  isStandardRoleType,
  type LiveRole,
  type LiveRolePermission,
  type RoleSpec,
} from './validate'

/** One page of roles is read with this cap — custom roles per org are few. */
export const ROLE_LIST_LIMIT = 200

export interface RoleRollbackEntry {
  label: string
  existed: boolean
  /** The role id Okta assigns — the rollback key (never the label). */
  id?: string
  /** Prior { label, description }, captured before an update. */
  prior?: { label: string; description: string }
  /** Prior permission-type set, captured before an update so rollback restores it. */
  priorPermissions?: string[]
}

/**
 * Deploy custom admin roles via the Okta Roles API. NO UPSERT exists, so for each
 * declared role:
 *   - GET  /iam/roles                 — list and match by label
 *   - PUT  /iam/roles/{id}            — replace label/description (capture prior)
 *   - POST /iam/roles                 — create with the full permission set
 *
 * Okta only accepts the permission array at CREATE time. On UPDATE, PUT changes
 * only label/description, so the permission set is reconciled ONE AT A TIME via
 * the /permissions sub-resource (add missing / remove extra), mirroring how the
 * groups config type reconciles static membership.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.label && s.description && s.permissions.length > 0)
  const rollbackState: RoleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    // List every custom role once; match candidates in memory by label.
    const liveRoles = await listRoles(client)

    for (const spec of specs) {
      // Never manage a standard/built-in role (validate already rejects it).
      if (isStandardRoleType(spec.label)) {
        throw new Error(`Refusing to manage Okta standard/built-in role "${spec.label}"`)
      }

      const existing = findRoleByLabel(liveRoles, spec.label)

      if (existing?.id) {
        // UPDATE — replace label/description, then reconcile permissions via the
        // sub-resource. Capture the prior profile + permission set for rollback.
        const priorPermissions = await listRolePermissions(client, existing.id)
        rollbackState.push({
          label: spec.label,
          existed: true,
          id: existing.id,
          prior: {
            label: existing.label ?? spec.label,
            description: typeof existing.description === 'string' ? existing.description : '',
          },
          priorPermissions,
        })

        const res = await client.request('PUT', `/iam/roles/${existing.id}`, {
          body: { label: spec.label, description: spec.description },
        })
        if (!res.ok) {
          throw new Error(`Failed to update role "${spec.label}": ${oktaErrorMessage(res)}`)
        }
        await reconcilePermissions(client, existing.id, spec.permissions, priorPermissions)
      } else {
        // CREATE — the permission array is accepted here (the only place it is).
        const res = await client.request('POST', '/iam/roles', {
          body: { label: spec.label, description: spec.description, permissions: spec.permissions },
        })
        if (!res.ok) {
          throw new Error(`Failed to create role "${spec.label}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveRole>(res.body)
        if (!created?.id) {
          throw new Error(`Role "${spec.label}" was created but the API returned no id`)
        }
        rollbackState.push({ label: spec.label, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} custom admin role(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom admin role deployment failed after ${deployed.length} of ${specs.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRoles: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * List custom roles (one page, limit 200 — custom roles per org are few). The
 * IAM roles endpoint wraps the array as { roles: [...] }.
 */
export async function listRoles(client: OktaClient): Promise<LiveRole[]> {
  const res = await client.request('GET', '/iam/roles', { query: { limit: ROLE_LIST_LIMIT } })
  if (!res.ok) {
    throw new Error(`Failed to list custom admin roles: ${oktaErrorMessage(res)}`)
  }
  return parseJson<{ roles?: LiveRole[] }>(res.body)?.roles ?? []
}

/** Find a role by exact label; null when absent. */
export function findRoleByLabel(roles: LiveRole[], label: string): LiveRole | null {
  return roles.find((r) => r.label === label) ?? null
}

/** Read a role's current permission-type strings. */
export async function listRolePermissions(client: OktaClient, roleId: string): Promise<string[]> {
  const res = await client.request('GET', `/iam/roles/${roleId}/permissions`)
  if (!res.ok) {
    throw new Error(`Failed to list permissions for role ${roleId}: ${oktaErrorMessage(res)}`)
  }
  const perms = parseJson<{ permissions?: LiveRolePermission[] }>(res.body)?.permissions ?? []
  return perms.map((p) => p.label).filter((l): l is string => typeof l === 'string' && l.length > 0)
}

/**
 * Converge a role's permission set to exactly `desired` via the /permissions
 * sub-resource — add each missing permission, remove each extra one. A 404 on a
 * remove (already gone) is tolerated.
 */
export async function reconcilePermissions(
  client: OktaClient,
  roleId: string,
  desired: string[],
  current: string[],
): Promise<void> {
  const desiredSet = new Set(desired)
  const currentSet = new Set(current)

  for (const perm of desired) {
    if (!currentSet.has(perm)) {
      const res = await client.request('POST', `/iam/roles/${roleId}/permissions/${perm}`)
      if (!res.ok) {
        throw new Error(`Failed to add permission "${perm}" to role ${roleId}: ${oktaErrorMessage(res)}`)
      }
    }
  }

  for (const perm of current) {
    if (!desiredSet.has(perm)) {
      const res = await client.request('DELETE', `/iam/roles/${roleId}/permissions/${perm}`)
      if (!res.ok && res.status !== 404) {
        throw new Error(`Failed to remove permission "${perm}" from role ${roleId}: ${oktaErrorMessage(res)}`)
      }
    }
  }
}
