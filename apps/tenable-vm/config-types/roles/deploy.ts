import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import {
  extractRoleSpecs,
  isSystemRole,
  livePermissionStrings,
  type LiveRole,
  type RoleSpec,
} from './validate'

export interface RoleRollbackEntry {
  name: string
  existed: boolean
  uuid?: string
  prior?: {
    name?: string
    description?: string
    role_permission_strings?: string[]
  }
}

/**
 * Deploy access-control roles to a Tenable tenant via the Roles API.
 *
 * A role's logical identity is its NAME; the stable id Tenable assigns is a
 * uuid. For each declared role:
 *   - GET  /access-control/v1/roles          — list, then match on name
 *   - PUT  /access-control/v1/roles/{uuid}    — update an existing role (capture prior body)
 *   - POST /access-control/v1/roles           — create a missing role (capture new uuid)
 *
 * SENSITIVE RBAC: built-in roles are type SYSTEM and read-only. If a declared
 * role's name matches a live SYSTEM role, this REFUSES to modify it — the deploy
 * fails with a clear message and never issues the PUT, so a system role is never
 * mutated. Only CUSTOM roles are created or updated.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RoleRollbackEntry[] = []
  const createdUuids: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findRole(client, spec.name)

      if (existing) {
        // SENSITIVE RBAC guard: never mutate a built-in SYSTEM role. Refuse
        // BEFORE any write so a system role is never touched.
        if (isSystemRole(existing)) {
          throw new Error(
            `Role "${spec.name}" matches a built-in Tenable role (type SYSTEM${
              existing.uuid ? `, uuid ${existing.uuid}` : ''
            }) which is read-only — refusing to modify it. Choose a distinct custom role name.`,
          )
        }
        if (!existing.uuid) {
          throw new Error(`Role "${spec.name}" exists but Tenable returned no uuid — cannot update it safely`)
        }

        rollbackState.push({
          name: spec.name,
          existed: true,
          uuid: existing.uuid,
          prior: {
            name: existing.name,
            // Capture an explicit empty so rollback can clear a description the
            // deployment sets on a role that previously had none.
            description: existing.description ?? '',
            role_permission_strings: livePermissionStrings(existing),
          },
        })

        const res = await client.request('PUT', `/access-control/v1/roles/${existing.uuid}`, {
          body: buildUpdatePayload(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update role "${spec.name}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/access-control/v1/roles', {
          body: buildCreatePayload(spec),
        })
        if (!res.ok) {
          // A 409 here means a role with this name already exists (likely a
          // built-in) that the list did not surface — surface it clearly.
          throw new Error(`Failed to create role "${spec.name}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveRole>(res.body)
        if (!created?.uuid) {
          throw new Error(`Role "${spec.name}" was created but the API returned no uuid`)
        }
        rollbackState.push({ name: spec.name, existed: false, uuid: created.uuid })
        createdUuids.push(created.uuid)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} role(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState, createdUuids },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role deployment failed after ${deployed.length} of ${specs.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRoles: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdUuids },
    }
  }
}

// --- Helpers ---

/**
 * Find a role by name (case-insensitive; role names are unique in Tenable);
 * null when absent. Returns the full live record so the caller can inspect
 * `type` for the SYSTEM guard and capture prior state for rollback.
 */
export async function findRole(client: TenableClient, name: string): Promise<LiveRole | null> {
  const res = await client.request('GET', '/access-control/v1/roles')
  if (!res.ok) {
    throw new Error(`Failed to list roles while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const roles = parseJson<{ roles?: LiveRole[] }>(res.body)?.roles ?? []
  const target = name.toLowerCase()
  return roles.find((r) => (r.name ?? '').toLowerCase() === target) ?? null
}

/** Fetch a single role by uuid; null on 404. */
export async function getRoleByUuid(client: TenableClient, uuid: string): Promise<LiveRole | null> {
  const res = await client.request('GET', `/access-control/v1/roles/${uuid}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch role ${uuid}: ${tenableErrorMessage(res)}`)
  }
  return parseJson<LiveRole>(res.body)
}

function buildCreatePayload(spec: RoleSpec): Record<string, unknown> {
  // type CUSTOM is implied by POSTing to the roles endpoint — never sent as
  // SYSTEM. role_permission_strings is required; description is optional.
  const payload: Record<string, unknown> = {
    name: spec.name,
    role_permission_strings: spec.permissionStrings,
  }
  if (spec.description) payload.description = spec.description
  return payload
}

function buildUpdatePayload(spec: RoleSpec): Record<string, unknown> {
  // description is always sent so clearing it on the canvas converges the live
  // role (and drift detection agrees about the target state).
  return {
    name: spec.name,
    description: spec.description ?? '',
    role_permission_strings: spec.permissionStrings,
  }
}
