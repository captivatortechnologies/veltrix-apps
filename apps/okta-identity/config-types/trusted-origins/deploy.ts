import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractTrustedOriginSpecs,
  type LiveTrustedOrigin,
  type TrustedOriginSpec,
} from './validate'

export interface TrustedOriginRollbackEntry {
  name: string
  existed: boolean
  /** The trusted origin id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior lifecycle status (ACTIVE|INACTIVE), restored via lifecycle on rollback. */
  priorStatus?: string
  /** Prior origin body with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/** Server-managed fields Okta returns on a trusted origin but that must never be sent back. */
export const READONLY_TRUSTED_ORIGIN_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  'createdBy',
  'lastUpdatedBy',
  '_links',
  '_embedded',
  // status is managed by the lifecycle endpoints, not the PUT body.
  'status',
] as const

/**
 * Deploy trusted origins to an Okta org via the Trusted Origins API. NO UPSERT
 * exists, so for each declared origin:
 *   - GET  /trustedOrigins        — list (paginated) and match by name
 *   - PUT  /trustedOrigins/{id}   — update an existing origin (capture prior body)
 *   - POST /trustedOrigins        — create a missing origin (capture the new id)
 * then reconcile the origin's lifecycle status (ACTIVE/INACTIVE) via the lifecycle
 * endpoints, since status is not settable through the PUT body. Trusted origins
 * have no protected/system objects and can be deleted without deactivating first.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractTrustedOriginSpecs(ctx.canvas).filter((s) => s.name && s.origin && s.scopes.length > 0)
  const rollbackState: TrustedOriginRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findTrustedOrigin(client, spec.name)

      if (existing && existing.id) {
        // UPDATE IN PLACE — capture the prior body + status for rollback (keyed on
        // the returned id, never the name).
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          priorStatus: existing.status,
          prior: stripReadOnlyTrustedOriginFields(existing),
        })

        const res = await client.request('PUT', `/trustedOrigins/${existing.id}`, {
          body: buildTrustedOriginBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update trusted origin "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        await reconcileTrustedOriginStatus(client, existing.id, existing.status, spec.status)
      } else {
        const res = await client.request('POST', '/trustedOrigins', { body: buildTrustedOriginBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create trusted origin "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveTrustedOrigin>(res.body)
        if (!created?.id) {
          throw new Error(`Trusted origin "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
        // A newly created trusted origin is ACTIVE; deactivate it when INACTIVE is desired.
        await reconcileTrustedOriginStatus(client, created.id, created.status ?? 'ACTIVE', spec.status)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} trusted origin(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedTrustedOrigins: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Trusted origin deployment failed after ${deployed.length} of ${specs.length} origin(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedTrustedOrigins: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find a trusted origin by exact name across the paginated list; null when absent. */
export async function findTrustedOrigin(client: OktaClient, name: string): Promise<LiveTrustedOrigin | null> {
  const res = await client.getAll<LiveTrustedOrigin>('/trustedOrigins')
  if (!res.ok) {
    throw new Error(
      `Failed to list trusted origins while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((o) => o.name === name) ?? null
}

/** Fetch a single trusted origin by id; null on 404. */
export async function getTrustedOriginById(client: OktaClient, id: string): Promise<LiveTrustedOrigin | null> {
  const res = await client.request('GET', `/trustedOrigins/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch trusted origin ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveTrustedOrigin>(res.body)
}

/**
 * Build the create/update body from the modeled fields. The scope types are
 * expanded into the API's `[{ type }]` shape; status is NOT included (it is
 * converged separately via the lifecycle endpoints).
 */
export function buildTrustedOriginBody(spec: TrustedOriginSpec): Record<string, unknown> {
  return {
    name: spec.name,
    origin: spec.origin,
    scopes: spec.scopes.map((type) => ({ type })),
  }
}

/**
 * Converge a trusted origin's lifecycle status. Okta does not change status
 * through the PUT body — you activate/deactivate via the lifecycle endpoints.
 * No-op when the desired status already matches the current one. A 404 (origin
 * gone) is tolerated.
 */
export async function reconcileTrustedOriginStatus(
  client: OktaClient,
  originId: string,
  currentStatus: string | undefined,
  desiredStatus: string | undefined,
): Promise<void> {
  if (!desiredStatus) return
  const desired = desiredStatus.toUpperCase()
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desired) return

  const action = desired === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `/trustedOrigins/${originId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} trusted origin ${originId}: ${oktaErrorMessage(res)}`)
  }
}

/** Copy a live trusted origin without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyTrustedOriginFields(origin: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(origin)) {
    if (!(READONLY_TRUSTED_ORIGIN_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
