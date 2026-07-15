import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  buildClaimBody,
  extractClaimSpecs,
  stripReadOnlyClaimFields,
  type ClaimSpec,
  type LiveClaim,
} from './validate'

/** Prior state of one claim, captured during deploy so rollback can revert it. */
export interface ClaimRollbackEntry {
  /** The parent auth server id — needed to build the claim path on rollback. */
  authServerId: string
  name: string
  /** True when the claim existed before this deploy (updated), false when created. */
  existed: boolean
  /** The claim id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior claim body with server-managed readOnly fields stripped, replayed via PUT. */
  prior?: Record<string, unknown>
}

/** Build the collection path for an auth server's claims. */
export function claimsPath(authServerId: string): string {
  return `/authorizationServers/${encodeURIComponent(authServerId)}/claims`
}

/** Build the single-claim path. */
export function claimPath(authServerId: string, claimId: string): string {
  return `${claimsPath(authServerId)}/${encodeURIComponent(claimId)}`
}

/**
 * Deploy Okta authorization-server claims via the Management API. A claim is a
 * CHILD of an auth server, so every request is scoped to the claim's
 * authServerId. Okta has NO upsert and claims have NO lifecycle endpoint (status
 * is part of the PUT body), so for each declared claim:
 *   - GET  /authorizationServers/{authServerId}/claims        — list, match by name
 *   - PUT  /authorizationServers/{authServerId}/claims/{id}   — replace (capture prior)
 *   - POST /authorizationServers/{authServerId}/claims        — create (capture new id)
 *
 * A live claim with `system: true` is Okta-managed (built-in) and is SKIPPED
 * entirely — never updated or deleted.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractClaimSpecs(ctx.canvas).filter((s) => s.authServerId && s.name)
  const rollbackState: ClaimRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []
  const skipped: string[] = []

  try {
    for (const spec of specs) {
      const label = `${spec.authServerId}:${spec.name}`
      const existing = await findClaim(client, spec.authServerId, spec.name)

      if (existing && existing.system === true) {
        // Okta-managed system claim — never update or delete it.
        skipped.push(label)
        continue
      }

      if (existing && existing.id) {
        // UPDATE IN PLACE. Capture the prior body (readOnly fields stripped) keyed
        // on the returned id for rollback.
        rollbackState.push({
          authServerId: spec.authServerId,
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: stripReadOnlyClaimFields(existing),
        })

        const res = await client.request('PUT', claimPath(spec.authServerId, existing.id), {
          body: buildClaimBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update claim "${label}": ${oktaErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', claimsPath(spec.authServerId), {
          body: buildClaimBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create claim "${label}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveClaim>(res.body)
        if (!created?.id) {
          throw new Error(`Claim "${label}" was created but the API returned no id`)
        }
        rollbackState.push({ authServerId: spec.authServerId, name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(label)
    }

    const skippedNote = skipped.length ? ` Skipped ${skipped.length} Okta-managed system claim(s): ${skipped.join(', ')}.` : ''
    return {
      success: true,
      message: `Deployed ${deployed.length} claim(s) to Okta org at ${baseUrl}: ${deployed.join(', ') || '(none)'}.${skippedNote}`,
      artifacts: { baseUrl, deployedClaims: deployed, skippedClaims: skipped },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Claim deployment failed after ${deployed.length} of ${specs.length} claim(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedClaims: deployed, skippedClaims: skipped },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * Find a claim by name within one auth server's claim list; null when absent.
 * Lists every claim under the server (following pagination) and matches the name
 * exactly. A claim of the same name under a DIFFERENT auth server is never
 * adopted because the list is scoped to authServerId.
 */
export async function findClaim(
  client: OktaClient,
  authServerId: string,
  name: string,
): Promise<LiveClaim | null> {
  const res = await client.getAll<LiveClaim>(claimsPath(authServerId))
  if (!res.ok) {
    throw new Error(
      `Failed to list claims for authorization server "${authServerId}" while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((c) => c.name === name) ?? null
}

/** Fetch a single claim by id; null on 404. */
export async function getClaimById(
  client: OktaClient,
  authServerId: string,
  id: string,
): Promise<LiveClaim | null> {
  const res = await client.request('GET', claimPath(authServerId, id))
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch claim ${id} on authorization server "${authServerId}": ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveClaim>(res.body)
}

/** Re-export so drift/health share the same body builder as deploy. */
export type { ClaimSpec }
