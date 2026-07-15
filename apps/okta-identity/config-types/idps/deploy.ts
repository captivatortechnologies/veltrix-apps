import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractIdpSpecs,
  parseJsonObject,
  type IdpSpec,
  type LiveIdp,
} from './validate'

export interface IdpRollbackEntry {
  name: string
  existed: boolean
  /** The IdP id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior lifecycle status (ACTIVE|INACTIVE), restored via lifecycle on rollback. */
  priorStatus?: string
  /**
   * Prior IdP definition with server-managed readOnly fields stripped, replayed
   * via PUT on rollback. NOTE: the write-only protocol.credentials.client
   * .client_secret is not present here (Okta never returns it), so restoring an
   * UPDATED OIDC/OAUTH2 IdP cannot replay its secret — see rollback.ts.
   */
  prior?: Record<string, unknown>
}

/** Server-managed fields Okta returns on an IdP but that must never be sent back. */
export const READONLY_IDP_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  'system',
  '_links',
  '_embedded',
  // status is managed by the lifecycle endpoints, not the create/update body.
  'status',
] as const

/**
 * Deploy identity providers to an Okta org via the IdP API. NO UPSERT exists, so
 * for each declared IdP:
 *   - GET  /idps                — list (paginated) and match by name
 *   - PUT  /idps/{id}           — update an existing IdP (capture prior body)
 *   - POST /idps                — create a missing IdP (capture the new id)
 * then reconcile the IdP's lifecycle status (ACTIVE/INACTIVE) via the lifecycle
 * endpoints, since status is not settable through the create/update body.
 *
 * SENSITIVE: an IdP governs federated sign-in — a broken protocol or policy can
 * lock users out. The OAuth/OIDC client secret is authored inside protocolJson
 * (credentials.client.client_secret) and written on deploy; Okta stores it
 * write-only and never returns it, so it is excluded from drift detection.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractIdpSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: IdpRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Re-parse here to build the API body and to fail loudly rather than send a
      // malformed protocol/policy.
      const protocol = spec.protocolJson ? parseJsonObject(spec.protocolJson) : null
      if (protocol === null) {
        throw new Error(`IdP "${spec.name}": protocol (protocolJson) is not a valid JSON object`)
      }
      const policy = spec.policyJson ? parseJsonObject(spec.policyJson) : null
      if (spec.policyJson && policy === null) {
        throw new Error(`IdP "${spec.name}": policy (policyJson) is not a valid JSON object`)
      }

      const existing = await findIdp(client, spec.name)

      if (existing && existing.id) {
        // UPDATE IN PLACE. Capture the prior definition + status for rollback
        // (keyed on the returned id, never the name).
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          priorStatus: existing.status,
          prior: stripReadOnlyIdpFields(existing),
        })

        const res = await client.request('PUT', `/idps/${existing.id}`, {
          body: buildIdpBody(spec, protocol, policy),
        })
        if (!res.ok) {
          throw new Error(`Failed to update IdP "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        await reconcileIdpStatus(client, existing.id, existing.status, spec.status)
      } else {
        const res = await client.request('POST', '/idps', { body: buildIdpBody(spec, protocol, policy) })
        if (!res.ok) {
          throw new Error(`Failed to create IdP "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveIdp>(res.body)
        if (!created?.id) {
          throw new Error(`IdP "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
        // A newly created IdP is ACTIVE; deactivate it when INACTIVE is desired.
        await reconcileIdpStatus(client, created.id, created.status ?? 'ACTIVE', spec.status)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} identity provider(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}. Federated sign-in is sensitive — verify each IdP before relying on it.`,
      artifacts: { baseUrl, deployedIdps: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `IdP deployment failed after ${deployed.length} of ${specs.length} identity provider(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedIdps: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Find an IdP by exact name across the paginated IdP list; null when absent. */
export async function findIdp(client: OktaClient, name: string): Promise<LiveIdp | null> {
  const res = await client.getAll<LiveIdp>('/idps')
  if (!res.ok) {
    throw new Error(
      `Failed to list IdPs while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((i) => i.name === name) ?? null
}

/** Fetch a single IdP by id; null on 404. */
export async function getIdpById(client: OktaClient, id: string): Promise<LiveIdp | null> {
  const res = await client.request('GET', `/idps/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch IdP ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveIdp>(res.body)
}

/**
 * Build the create/update body: `protocol` and `policy` come from the parsed
 * JSON blobs, while type/name come from the modeled fields and always win — the
 * free-form JSON can never override the IdP's identity. status is NOT sent here;
 * it is reconciled via the lifecycle endpoints.
 */
export function buildIdpBody(
  spec: IdpSpec,
  protocol: Record<string, unknown>,
  policy: Record<string, unknown> | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = { type: spec.type, name: spec.name, protocol }
  if (policy) body.policy = policy
  return body
}

/**
 * Converge an IdP's lifecycle status. Okta does not change status through the
 * create/update body — you activate/deactivate via the lifecycle endpoints.
 * No-op when the desired status already matches the current one. A 404 (IdP
 * gone) is tolerated.
 */
export async function reconcileIdpStatus(
  client: OktaClient,
  idpId: string,
  currentStatus: string | undefined,
  desiredStatus: string | undefined,
): Promise<void> {
  if (!desiredStatus) return
  const desired = desiredStatus.toUpperCase()
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desired) return

  const action = desired === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `/idps/${idpId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} IdP ${idpId}: ${oktaErrorMessage(res)}`)
  }
}

/** Copy a live IdP without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyIdpFields(idp: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(idp)) {
    if (!(READONLY_IDP_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
