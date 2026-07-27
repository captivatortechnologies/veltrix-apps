import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import {
  createEntity,
  getEntities,
  type EntityEndpoints,
  type LiveEntity,
} from '../../lib/entityAdapter'
import { extractInstallationTokenSpecs, type InstallationTokenSpec } from './validate'

/**
 * Installation Tokens API surface (verified against FalconPy `installation_tokens`
 * + gofalcon api_token models). Identity is `label`.
 *
 * Transport asymmetry vs. the generic entity adapter:
 *   - query  GET    /queries/tokens/v1                — returns token ids
 *   - get    GET    /entities/tokens/v1?ids=…         — adapter getEntities
 *   - create POST   /entities/tokens/v1              — body object; adapter createEntity
 *   - update PATCH  /entities/tokens/v1?ids=<id>      — id in QUERY, not body → local updateToken
 *   - delete DELETE /entities/tokens/v1?ids=<id>      — adapter deleteEntity
 *
 * The label is not relied on as an FQL filter field (its filterability is not
 * documented publicly), so findTokenByLabel lists tokens and matches the label
 * client-side — correct regardless of the queries endpoint's filter support.
 */
export const INSTALLATION_TOKEN_ENDPOINTS: EntityEndpoints = {
  entity: '/installation-tokens/entities/tokens/v1',
  queries: '/installation-tokens/queries/tokens/v1',
  identityField: 'label',
}

/**
 * A live token as returned by GET /installation-tokens/entities/tokens/v1.
 * The read shape has NO `revoked` boolean — revoke state is derived from
 * `status`/`revoked_timestamp` — and NO modifier field (drift attribution is
 * best-effort via the inherited `modified_by`, which Falcon does not populate
 * on tokens today).
 */
export interface LiveToken extends LiveEntity {
  /** The token SECRET — returned on create/read. NEVER logged, stored, or diffed. */
  value?: string
  label?: string
  expires_timestamp?: string
  revoked_timestamp?: string
  status?: string
  type?: string
  created_timestamp?: string
  last_used_timestamp?: string
}

/** Token fields this app manages and can restore on rollback (never the value). */
export interface InstallationTokenRollbackEntry {
  label: string
  existed: boolean
  id?: string
  prior?: {
    label: string
    expiresTimestamp: string
    revoked: boolean
  }
}

const DEPLOY_LABEL_MAX = 100

/**
 * Deploy installation tokens to a Falcon tenant via the Installation Tokens API.
 *
 * For each declared token:
 *   - find it by its `label` identity
 *   - if it exists, PATCH the managed fields (label / expiry / revoke)
 *   - otherwise POST a new token, then PATCH revoked:true when requested
 *     (create cannot set the revoke state)
 *
 * The generated token secret is discarded immediately — it is never returned in
 * the result, captured in rollback data, or logged. Prior state is captured so
 * rollback can revert updates and delete anything this deploy created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractInstallationTokenSpecs(ctx.canvas).filter((s) => s.label)
  const rollbackState: InstallationTokenRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findTokenByLabel(client, spec.label)

      if (existing?.id) {
        rollbackState.push({
          label: spec.label,
          existed: true,
          id: existing.id,
          prior: {
            label: typeof existing.label === 'string' ? existing.label : spec.label,
            expiresTimestamp: liveExpiry(existing),
            revoked: deriveRevoked(existing),
          },
        })

        await updateToken(client, existing.id, buildPatchBody(spec))
      } else {
        // createEntity returns only the new id; the secret in resources[0].value
        // is never read, so it cannot leak into logs or rollback data.
        const id = await createEntity(client, INSTALLATION_TOKEN_ENDPOINTS, buildCreateBody(spec))
        rollbackState.push({ label: spec.label, existed: false, id })
        // A new token is created active; apply the requested revoke state after.
        if (spec.revoked) {
          await updateToken(client, id, { revoked: true })
        }
      }

      deployed.push(spec.label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} installation token(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedTokens: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Installation token deployment failed after ${deployed.length} of ${specs.length} token(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedTokens: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Transport helpers (shared by rollback / driftDetect / healthCheck) ------

/**
 * Find a token by its exact `label`, listing tokens and matching client-side so
 * this never depends on `label` being an FQL-filterable field. Returns the
 * first exact-label match, or null. Reuses the adapter's getEntities for the
 * id → entity fetch (which uses ?ids=, the transport tokens require).
 */
export async function findTokenByLabel(
  client: FalconClient,
  label: string,
): Promise<LiveToken | null> {
  const limit = 1000
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', INSTALLATION_TOKEN_ENDPOINTS.queries, {
      query: { limit, offset },
    })
    if (!res.ok) {
      throw new Error(`Failed to list installation tokens: ${falconErrorMessage(res)}`)
    }
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    if (ids.length > 0) {
      const entities = (await getEntities(client, INSTALLATION_TOKEN_ENDPOINTS, ids)) as LiveToken[]
      const match = entities.find((t) => t.label === label)
      if (match) return match
    }
    if (ids.length < limit) break
  }
  return null
}

/**
 * Update a token. Unlike the generic adapter's updateEntity (which puts the id
 * in the body), the Installation Tokens API requires the id in the `ids` query
 * parameter; the body carries only the mutable fields.
 */
export async function updateToken(
  client: FalconClient,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await client.request('PATCH', INSTALLATION_TOKEN_ENDPOINTS.entity, {
    query: { ids: id },
    body,
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to update token: ${failure}`)
}

/**
 * Derive the revoke state from a live token. The read shape exposes no `revoked`
 * boolean — a revoked token reports status "revoked" and carries a
 * revoked_timestamp — so both signals are checked.
 */
export function deriveRevoked(live: LiveToken): boolean {
  if (typeof live.status === 'string' && live.status.trim().toLowerCase() === 'revoked') return true
  return typeof live.revoked_timestamp === 'string' && live.revoked_timestamp.trim() !== ''
}

/** Read a live token's expiry as a string, or '' when it never expires. */
export function liveExpiry(live: LiveToken): string {
  return typeof live.expires_timestamp === 'string' ? live.expires_timestamp : ''
}

/** Create body: label plus an optional expiry (omitted for a never-expiring token). */
export function buildCreateBody(spec: InstallationTokenSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { label: spec.label.slice(0, DEPLOY_LABEL_MAX) }
  if (spec.expiresTimestamp) body.expires_timestamp = spec.expiresTimestamp
  return body
}

/**
 * Patch body: label + revoke state, plus an optional expiry. An empty expiry is
 * omitted rather than sent — the API has no verified way to clear an expiry via
 * PATCH, so a token that already has one keeps it (documented limitation).
 */
export function buildPatchBody(spec: InstallationTokenSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    label: spec.label.slice(0, DEPLOY_LABEL_MAX),
    revoked: spec.revoked,
  }
  if (spec.expiresTimestamp) body.expires_timestamp = spec.expiresTimestamp
  return body
}
