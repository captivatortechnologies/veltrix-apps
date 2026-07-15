import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  authenticatorIdentity,
  extractAuthenticatorSpecs,
  isCreatableKey,
  isMultiInstanceKey,
  isNonDeactivatableKey,
  KEY_TYPES,
  parseJsonObject,
  type AuthenticatorSpec,
  type LiveAuthenticator,
} from './validate'

export interface AuthenticatorRollbackEntry {
  /** Logical identity — key, or key::name for a multi-instance authenticator. */
  identity: string
  key: string
  name: string
  existed: boolean
  /** The authenticator id Okta assigns — the rollback key (never the identity). */
  id?: string
  /** Prior lifecycle status (ACTIVE|INACTIVE), restored via lifecycle on rollback. */
  priorStatus?: string
  /** Prior authenticator body with server-managed readOnly fields stripped, replayed via PUT. */
  prior?: Record<string, unknown>
}

/**
 * Server-managed fields Okta returns on an authenticator that must never be sent
 * back. `status` is driven by the lifecycle endpoints, not the PUT body.
 */
export const READONLY_AUTHENTICATOR_FIELDS = [
  'id',
  'created',
  'lastUpdated',
  '_links',
  '_embedded',
  'status',
] as const

/**
 * Deploy authenticators to an Okta org. The Authenticators API has NO UPSERT and
 * NO DELETE, so for each declared authenticator:
 *   - GET  /authenticators              — list (paginated); match by key
 *                                          (key+name for a multi-instance key)
 *   - PUT  /authenticators/{id}         — update an existing one (capture prior)
 *   - POST /authenticators?activate=true — create a MISSING one, but ONLY for a
 *                                          creatable key (custom_* / external_idp /
 *                                          provider); custom_app adds
 *                                          agreeToTerms:true
 * then reconcile the desired status (ACTIVE/INACTIVE) via the lifecycle
 * endpoints. A built-in okta_* authenticator is one-per-org and is only ever
 * UPDATED + toggled — never created; if it is somehow absent, deploy fails
 * loudly rather than trying to create it. okta_password can never be deactivated.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAuthenticatorSpecs(ctx.canvas).filter((s) => s.key)
  const rollbackState: AuthenticatorRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []
  const notes: string[] = []

  try {
    for (const spec of specs) {
      const identity = authenticatorIdentity(spec.key, spec.name)
      const existing = await findAuthenticator(client, spec)

      if (existing && existing.id) {
        // UPDATE IN PLACE — the only operation for a matched (incl. built-in)
        // authenticator. Capture the prior body + status for rollback.
        rollbackState.push({
          identity,
          key: spec.key,
          name: spec.name,
          existed: true,
          id: existing.id,
          priorStatus: existing.status,
          prior: stripReadOnlyAuthenticatorFields(existing),
        })

        const res = await client.request('PUT', `/authenticators/${existing.id}`, {
          body: buildUpdateBody(existing, spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update authenticator "${identity}": ${oktaErrorMessage(res)}`)
        }
        const skipped = await reconcileAuthenticatorStatus(
          client,
          existing.id,
          spec.key,
          existing.status,
          spec.status,
        )
        if (skipped) notes.push(skipped)
      } else {
        // A built-in authenticator is seeded one-per-org and cannot be created —
        // only the custom/provider keys are creatable.
        if (!isCreatableKey(spec.key)) {
          throw new Error(
            `Built-in authenticator "${spec.key}" was not found in the Okta org and cannot be created — ` +
              `Okta seeds it automatically. Verify the key, or that the feature is enabled for the org.`,
          )
        }
        const res = await client.request('POST', '/authenticators', {
          query: { activate: true },
          body: buildCreateBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create authenticator "${identity}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveAuthenticator>(res.body)
        if (!created?.id) {
          throw new Error(`Authenticator "${identity}" was created but the API returned no id`)
        }
        rollbackState.push({ identity, key: spec.key, name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
        // Created with ?activate=true → born ACTIVE; deactivate when INACTIVE
        // is desired (a non-deactivatable key stays ACTIVE).
        const skipped = await reconcileAuthenticatorStatus(
          client,
          created.id,
          spec.key,
          created.status ?? 'ACTIVE',
          spec.status,
        )
        if (skipped) notes.push(skipped)
      }

      deployed.push(identity)
    }

    const noteSuffix = notes.length ? ` Notes: ${notes.join('; ')}.` : ''
    return {
      success: true,
      message:
        `Deployed ${deployed.length} authenticator(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}.` +
        ` Okta authenticators are never deleted — an unwanted one is deactivated instead.${noteSuffix}`,
      artifacts: { baseUrl, deployedAuthenticators: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Authenticator deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedAuthenticators: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * Find an authenticator matching a spec across the paginated list; null when
 * absent. A multi-instance key (custom_* / external_idp) matches on key AND name;
 * every other key matches on key alone (one per org).
 */
export async function findAuthenticator(
  client: OktaClient,
  spec: AuthenticatorSpec,
): Promise<LiveAuthenticator | null> {
  const res = await client.getAll<LiveAuthenticator>('/authenticators')
  if (!res.ok) {
    throw new Error(
      `Failed to list authenticators while resolving "${authenticatorIdentity(spec.key, spec.name)}": ${oktaErrorMessage(
        { status: res.status, ok: res.ok, body: res.body, nextUrl: null },
      )}`,
    )
  }
  const matchName = isMultiInstanceKey(spec.key)
  return (
    res.items.find((a) => a.key === spec.key && (!matchName || (a.name ?? '') === spec.name)) ?? null
  )
}

/** Fetch a single authenticator by id; null on 404. */
export async function getAuthenticatorById(
  client: OktaClient,
  id: string,
): Promise<LiveAuthenticator | null> {
  const res = await client.request('GET', `/authenticators/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch authenticator ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveAuthenticator>(res.body)
}

/**
 * Build a `provider` object from the authored (non-secret) provider JSON and the
 * write-only secret / integration key, merging the secrets into
 * `provider.configuration`. Returns undefined when there is nothing to send.
 */
export function buildProvider(
  providerObj: Record<string, unknown> | undefined,
  secretKey: string | undefined,
  integrationKey: string | undefined,
): Record<string, unknown> | undefined {
  if (!providerObj && !secretKey && !integrationKey) return undefined
  const provider: Record<string, unknown> = providerObj ? { ...providerObj } : {}
  if (secretKey || integrationKey) {
    const rawConfig = provider.configuration
    const configuration: Record<string, unknown> =
      rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
        ? { ...(rawConfig as Record<string, unknown>) }
        : {}
    if (secretKey) configuration.secretKey = secretKey
    if (integrationKey) configuration.integrationKey = integrationKey
    provider.configuration = configuration
  }
  return provider
}

/**
 * Build the CREATE body for a creatable authenticator: key (+ mapped type +
 * name), settings and provider (with merged secrets). custom_app must accept the
 * partner terms (agreeToTerms:true).
 */
export function buildCreateBody(spec: AuthenticatorSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { key: spec.key }
  const type = KEY_TYPES[spec.key]
  if (type) body.type = type
  if (spec.name) body.name = spec.name

  const settings = spec.settingsJson ? parseJsonObject(spec.settingsJson) : undefined
  if (settings) body.settings = settings

  const authoredProvider = spec.providerJson ? parseJsonObject(spec.providerJson) : undefined
  const provider = buildProvider(authoredProvider ?? undefined, spec.secretKey, spec.integrationKey)
  if (provider) body.provider = provider

  if (spec.key === 'custom_app') body.agreeToTerms = true
  return body
}

/**
 * Build the UPDATE (PUT) body for an existing authenticator. Start from the live
 * object with the server-managed readOnly fields stripped (so its type/key are
 * preserved), then overlay the authored name / settings / provider. The
 * write-only secrets are merged into the provider configuration when supplied.
 */
export function buildUpdateBody(
  live: LiveAuthenticator,
  spec: AuthenticatorSpec,
): Record<string, unknown> {
  const base = stripReadOnlyAuthenticatorFields(live)
  base.key = spec.key
  if (spec.name) base.name = spec.name

  const settings = spec.settingsJson ? parseJsonObject(spec.settingsJson) : undefined
  if (settings) base.settings = settings

  const authoredProvider = spec.providerJson ? parseJsonObject(spec.providerJson) : undefined
  if (authoredProvider || spec.secretKey || spec.integrationKey) {
    const existingProvider =
      base.provider && typeof base.provider === 'object' && !Array.isArray(base.provider)
        ? (base.provider as Record<string, unknown>)
        : undefined
    const provider = buildProvider(authoredProvider ?? existingProvider, spec.secretKey, spec.integrationKey)
    if (provider) base.provider = provider
  }
  return base
}

/**
 * Converge an authenticator's lifecycle status via the activate/deactivate
 * endpoints (status is not settable through the PUT body). No-op when the
 * desired status already matches. A non-deactivatable key (okta_password) is
 * never deactivated — that is returned as a human-readable note. A 404 is
 * tolerated (the authenticator is gone).
 */
export async function reconcileAuthenticatorStatus(
  client: OktaClient,
  id: string,
  key: string,
  currentStatus: string | undefined,
  desiredStatus: string | undefined,
): Promise<string | null> {
  if (!desiredStatus) return null
  const desired = desiredStatus.toUpperCase()
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desired) return null

  if (desired === 'INACTIVE' && isNonDeactivatableKey(key)) {
    return `"${key}" cannot be deactivated (it is a required authenticator) — left ACTIVE`
  }

  const action = desired === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `/authenticators/${id}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} authenticator "${key}": ${oktaErrorMessage(res)}`)
  }
  return null
}

/** Copy a live authenticator without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyAuthenticatorFields(
  authenticator: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(authenticator)) {
    if (!(READONLY_AUTHENTICATOR_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
