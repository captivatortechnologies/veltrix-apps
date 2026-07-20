import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import { extractUserTypeSpecs, type LiveUserType, type UserTypeSpec } from './validate'

export interface UserTypeRollbackEntry {
  name: string
  existed: boolean
  /** The user-type id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior { name, displayName, description }, captured before an update. */
  prior?: { name: string; displayName: string; description: string }
}

/**
 * Deploy user types to an Okta org via the User Types API. NO UPSERT exists, so
 * for each declared type:
 *   - GET  /meta/types/user          — list and match by name
 *   - PUT  /meta/types/user/{id}     — replace an existing type (capture prior)
 *   - POST /meta/types/user          — create a missing type (capture new id)
 *
 * `name` is IMMUTABLE in Okta, so a matched type is only ever updated in place
 * (its displayName / description) — the name is re-sent unchanged. There is no
 * lifecycle to reconcile.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractUserTypeSpecs(ctx.canvas).filter((s) => s.name && s.displayName)
  const rollbackState: UserTypeRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    // List every user type once; match candidates in memory by name.
    const liveTypes = await listUserTypes(client)

    for (const spec of specs) {
      const existing = findUserTypeByName(liveTypes, spec.name)

      if (existing?.id) {
        // UPDATE IN PLACE — replace displayName / description; name is re-sent
        // unchanged (Okta rejects a name change). Capture the prior for rollback.
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name ?? spec.name,
            displayName: existing.displayName ?? '',
            description: typeof existing.description === 'string' ? existing.description : '',
          },
        })

        const res = await client.request('PUT', `/meta/types/user/${existing.id}`, {
          body: buildUserTypeBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update user type "${spec.name}": ${oktaErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/meta/types/user', { body: buildUserTypeBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create user type "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveUserType>(res.body)
        if (!created?.id) {
          throw new Error(`User type "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} user type(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedUserTypes: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `User type deployment failed after ${deployed.length} of ${specs.length} type(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedUserTypes: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * List every user type in the org. The collection is small (Okta caps an org at
 * 10) and returned as a single JSON array, so no pagination is needed.
 */
export async function listUserTypes(client: OktaClient): Promise<LiveUserType[]> {
  const res = await client.getAll<LiveUserType>('/meta/types/user')
  if (!res.ok) {
    throw new Error(
      `Failed to list user types: ${oktaErrorMessage({ status: res.status, ok: res.ok, body: res.body, nextUrl: null })}`,
    )
  }
  return res.items
}

/** Find a user type by exact name; null when absent. */
export function findUserTypeByName(types: LiveUserType[], name: string): LiveUserType | null {
  return types.find((t) => t.name === name) ?? null
}

/** Fetch a single user type by id; null on 404. */
export async function getUserTypeById(client: OktaClient, id: string): Promise<LiveUserType | null> {
  const res = await client.request('GET', `/meta/types/user/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch user type ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveUserType>(res.body)
}

/**
 * Build the create/replace body. name is always sent (required by PUT and used
 * on create; unchangeable after create). description is always sent (empty string
 * when absent) so a PUT converges the live type and drift detection agrees.
 */
export function buildUserTypeBody(spec: UserTypeSpec): Record<string, unknown> {
  return {
    name: spec.name,
    displayName: spec.displayName,
    description: spec.description ?? '',
  }
}
