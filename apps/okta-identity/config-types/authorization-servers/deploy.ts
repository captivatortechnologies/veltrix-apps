import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractAuthServerSpecs,
  isProtectedServerId,
  type AuthServerSpec,
  type LiveAuthServer,
} from './validate'

export interface AuthServerRollbackEntry {
  name: string
  existed: boolean
  /** The server id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior lifecycle status (ACTIVE|INACTIVE), restored via lifecycle on rollback. */
  priorStatus?: string
  /** Prior server body with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/**
 * Server-managed fields Okta returns on an authorization server but that must
 * never be sent back. `issuer` and `credentials` are readOnly (Okta owns them);
 * `status` is managed by the lifecycle endpoints, not the PUT body.
 */
export const READONLY_AUTH_SERVER_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  'issuer',
  'credentials',
  'system',
  '_links',
  '_embedded',
  'status',
] as const

/**
 * Deploy custom authorization servers to an Okta org via the Authorization
 * Servers API. NO UPSERT exists, so for each declared server:
 *   - GET  /authorizationServers        — list (paginated) and match by name
 *   - PUT  /authorizationServers/{id}    — update an existing server (capture prior)
 *   - POST /authorizationServers         — create a missing server (capture new id)
 * then reconcile the server's lifecycle status (ACTIVE/INACTIVE) via the
 * lifecycle endpoints, since status is not settable through the PUT body.
 *
 * A matched (existing) server is only ever UPDATED in place — deploy never
 * deletes, so the Okta-provided default server (id 'default') is safe to
 * converge: it is updated in place and never deleted or recreated.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAuthServerSpecs(ctx.canvas).filter((s) => s.name && s.audiences.length === 1)
  const rollbackState: AuthServerRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findAuthServer(client, spec.name)

      if (existing && existing.id) {
        // UPDATE IN PLACE — the only operation allowed against a matched server,
        // including the Okta-provided default server (id 'default'). Capture the
        // prior body + status for rollback (keyed on the returned id, never name).
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          priorStatus: existing.status,
          prior: stripReadOnlyAuthServerFields(existing),
        })

        const res = await client.request('PUT', `/authorizationServers/${existing.id}`, {
          body: buildAuthServerBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update authorization server "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        await reconcileAuthServerStatus(client, existing.id, existing.status, spec.status)
      } else {
        const res = await client.request('POST', '/authorizationServers', {
          body: buildAuthServerBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create authorization server "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveAuthServer>(res.body)
        if (!created?.id) {
          throw new Error(`Authorization server "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
        // A newly created server is ACTIVE; deactivate it when INACTIVE is desired.
        await reconcileAuthServerStatus(client, created.id, created.status ?? 'ACTIVE', spec.status)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} authorization server(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedAuthServers: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Authorization server deployment failed after ${deployed.length} of ${specs.length} server(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedAuthServers: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Find an authorization server by exact name across the paginated list; null when absent. */
export async function findAuthServer(client: OktaClient, name: string): Promise<LiveAuthServer | null> {
  const res = await client.getAll<LiveAuthServer>('/authorizationServers')
  if (!res.ok) {
    throw new Error(
      `Failed to list authorization servers while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((s) => s.name === name) ?? null
}

/** Fetch a single authorization server by id; null on 404. */
export async function getAuthServerById(client: OktaClient, id: string): Promise<LiveAuthServer | null> {
  const res = await client.request('GET', `/authorizationServers/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch authorization server ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveAuthServer>(res.body)
}

/**
 * Build the create/update body from the modelled fields. `issuer` and
 * `credentials` are readOnly (never sent); `status` is driven by the lifecycle
 * endpoints, not the body. description is always sent so clearing it converges.
 */
export function buildAuthServerBody(spec: AuthServerSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
    audiences: spec.audiences,
  }
  if (spec.issuerMode) body.issuerMode = spec.issuerMode
  return body
}

/**
 * Converge a server's lifecycle status. Okta does not change status through the
 * PUT body — you activate/deactivate via the lifecycle endpoints. No-op when the
 * desired status already matches the current one. A 404 (server gone) is tolerated.
 */
export async function reconcileAuthServerStatus(
  client: OktaClient,
  serverId: string,
  currentStatus: string | undefined,
  desiredStatus: string | undefined,
): Promise<void> {
  if (!desiredStatus) return
  const desired = desiredStatus.toUpperCase()
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desired) return

  const action = desired === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `/authorizationServers/${serverId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} authorization server ${serverId}: ${oktaErrorMessage(res)}`)
  }
}

/** Copy a live server without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyAuthServerFields(server: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(server)) {
    if (!(READONLY_AUTH_SERVER_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}

/** Re-export the protected-id guard so rollback can refuse to delete the default server. */
export { isProtectedServerId }
