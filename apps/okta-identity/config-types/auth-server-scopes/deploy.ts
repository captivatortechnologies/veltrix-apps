import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import { extractScopeSpecs, isReservedScopeName, type LiveScope, type ScopeSpec } from './validate'

export interface ScopeRollbackEntry {
  /** Parent authorization server id — needed to build the scope's REST path. */
  authServerId: string
  name: string
  existed: boolean
  /** The scope id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior scope body with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/** Server-managed fields Okta returns on a scope but that must never be sent back. */
export const READONLY_SCOPE_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  'system',
  '_links',
  '_embedded',
] as const

/**
 * Deploy authorization-server scopes to an Okta org. A scope is a CHILD of a
 * custom authorization server, so every route is nested under
 * `/authorizationServers/{authServerId}/scopes`. Okta has NO upsert, so for each
 * declared scope:
 *   - GET  /authorizationServers/{authServerId}/scopes        — list, match by name
 *   - PUT  /authorizationServers/{authServerId}/scopes/{id}   — update (capture prior)
 *   - POST /authorizationServers/{authServerId}/scopes        — create (capture id)
 *
 * A matched live scope that is `system: true` (Okta's built-in openid/profile/
 * email/… scopes) is SKIPPED — never updated or deleted. validate already blocks
 * the reserved names; this is the live backstop. There is NO lifecycle for a
 * scope, so no status reconciliation.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractScopeSpecs(ctx.canvas).filter((s) => s.authServerId && s.name)
  const rollbackState: ScopeRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []
  const skipped: string[] = []

  try {
    for (const spec of specs) {
      const label = `${spec.authServerId}:${spec.name}`
      const existing = await findScope(client, spec.authServerId, spec.name)

      if (existing && existing.id) {
        // SKIP a live system scope — never update or delete Okta's built-ins.
        if (existing.system === true) {
          skipped.push(`${label} (built-in system scope — left untouched)`)
          continue
        }

        // UPDATE IN PLACE. Capture the prior body (keyed on the returned id) so
        // rollback can PUT it back.
        rollbackState.push({
          authServerId: spec.authServerId,
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: stripReadOnlyScopeFields(existing),
        })

        const res = await client.request(
          'PUT',
          `/authorizationServers/${spec.authServerId}/scopes/${existing.id}`,
          { body: buildScopeBody(spec) },
        )
        if (!res.ok) {
          throw new Error(`Failed to update scope "${label}": ${oktaErrorMessage(res)}`)
        }
      } else {
        // A reserved system scope must never be created. validate already rejects
        // these names; this is a defensive backstop.
        if (isReservedScopeName(spec.name)) {
          throw new Error(
            `Scope "${label}" is a reserved Okta system scope and cannot be created — Okta manages it`,
          )
        }
        const res = await client.request('POST', `/authorizationServers/${spec.authServerId}/scopes`, {
          body: buildScopeBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create scope "${label}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveScope>(res.body)
        if (!created?.id) {
          throw new Error(`Scope "${label}" was created but the API returned no id`)
        }
        rollbackState.push({ authServerId: spec.authServerId, name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(label)
    }

    const skipNote = skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''
    return {
      success: true,
      message: `Deployed ${deployed.length} authorization-server scope(s) to Okta org at ${baseUrl}: ${
        deployed.join(', ') || 'none'
      }.${skipNote}`,
      artifacts: { baseUrl, deployedScopes: deployed, skippedScopes: skipped },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Authorization-server scope deployment failed after ${deployed.length} of ${specs.length} scope(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedScopes: deployed, skippedScopes: skipped },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * Find a scope by exact name under a given authorization server; null when
 * absent. Lists every scope on the server (following pagination) and matches the
 * name exactly — scope names are case-sensitive.
 */
export async function findScope(
  client: OktaClient,
  authServerId: string,
  name: string,
): Promise<LiveScope | null> {
  const res = await client.getAll<LiveScope>(`/authorizationServers/${authServerId}/scopes`)
  if (!res.ok) {
    throw new Error(
      `Failed to list scopes on authorization server "${authServerId}" while resolving "${name}": ${oktaErrorMessage(
        { status: res.status, ok: res.ok, body: res.body, nextUrl: null },
      )}`,
    )
  }
  return res.items.find((s) => s.name === name) ?? null
}

/** Fetch a single scope by id; null on 404. */
export async function getScopeById(
  client: OktaClient,
  authServerId: string,
  id: string,
): Promise<LiveScope | null> {
  const res = await client.request('GET', `/authorizationServers/${authServerId}/scopes/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch scope ${id} on authorization server "${authServerId}": ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveScope>(res.body)
}

/**
 * Build the create/replace scope body from the modeled fields. name/consent/
 * default/metadataPublish/optional are always sent; displayName/description only
 * when present (PUT is a full replace, so omitting them clears them). The
 * free-form fields can never override the scope's identity (name).
 */
export function buildScopeBody(spec: ScopeSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    consent: spec.consent,
    default: spec.default,
    metadataPublish: spec.metadataPublish,
    optional: spec.optional,
  }
  if (spec.displayName) body.displayName = spec.displayName
  if (spec.description) body.description = spec.description
  return body
}

/** Copy a live scope without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyScopeFields(scope: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(scope)) {
    if (!(READONLY_SCOPE_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
