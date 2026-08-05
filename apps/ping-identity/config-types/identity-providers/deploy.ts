import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage, type PingOneClient } from '../../lib/pingOne'
import { extractIdentityProviderSpecs, type IdentityProviderSpec, type LiveIdentityProvider } from './validate'

export interface IdentityProviderRollbackEntry {
  name: string
  existed: boolean
  /** The identity-provider id PingOne assigns - the rollback key (never the name). */
  id?: string
  /**
   * Prior provider body with server-managed readOnly fields AND secret fields
   * stripped, replayed via PUT on rollback. The secret strip is defensive -
   * PingOne never returns clientSecret/appSecret/clientSecretSigningKey on a
   * GET in the first place, so there is nothing to leak, but a restored
   * (UPDATED) provider still has no secret to replay - see rollback.ts.
   */
  prior?: Record<string, unknown>
}

/** Server-managed fields PingOne returns on a provider but that must never be sent back. */
export const READONLY_IDENTITY_PROVIDER_FIELDS = ['id', 'environment', 'createdAt', 'updatedAt', '_links'] as const

/**
 * Write-only secret fields PingOne never returns on a GET. Stripped
 * defensively from any captured "prior" body before it is replayed by
 * rollback - see the note on IdentityProviderRollbackEntry.prior.
 */
export const SECRET_IDENTITY_PROVIDER_FIELDS = ['clientSecret', 'appSecret', 'clientSecretSigningKey'] as const

/**
 * Deploy identity providers to a PingOne environment. NO UPSERT exists, so for
 * each declared provider:
 *   - GET  /identityProviders             - list (paginated) and match by name
 *   - PUT  /identityProviders/{id}        - update an existing provider (capture prior body)
 *   - POST /identityProviders             - create a missing provider (capture the new id)
 *
 * A matched (existing) provider is only ever UPDATED in place; deploy never
 * deletes a provider this canvas doesn't declare.
 *
 * SENSITIVE: an identity provider governs federated sign-in - a broken
 * endpoint or credential can lock users out. Every secret (client secret, app
 * secret, Apple's signing key) is authored on the canvas and sent on every
 * deploy; PingOne stores it write-only and never returns it, so it is
 * excluded from drift detection (see driftDetect.ts).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, environmentId } = built

  const specs = extractIdentityProviderSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: IdentityProviderRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const body = buildIdentityProviderBody(spec)
      const existing = await findIdentityProvider(client, spec.name)

      if (existing && existing.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: stripToSafePriorBody(existing),
        })

        const res = await client.request('PUT', `/identityProviders/${existing.id}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to update identity provider "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/identityProviders', { body })
        if (!res.ok) {
          throw new Error(`Failed to create identity provider "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
        const created = parseJson<LiveIdentityProvider>(res.body)
        if (!created?.id) {
          throw new Error(`Identity provider "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} identity provider(s) to PingOne environment ${environmentId}: ${deployed.join(', ')}. Federated sign-in is sensitive - verify each provider before relying on it.`,
      artifacts: { environmentId, deployedIdentityProviders: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Identity provider deployment failed after ${deployed.length} of ${specs.length} provider(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { environmentId, deployedIdentityProviders: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Find an identity provider by exact name across the paginated list; null when absent. */
export async function findIdentityProvider(client: PingOneClient, name: string): Promise<LiveIdentityProvider | null> {
  const res = await client.getAll<LiveIdentityProvider>('/identityProviders', 'identityProviders')
  if (!res.ok) {
    throw new Error(
      `Failed to list identity providers while resolving "${name}": ${pingOneErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
      })}`,
    )
  }
  return res.items.find((p) => p.name === name) ?? null
}

/** Fetch a single identity provider by id; null on 404. */
export async function getIdentityProviderById(client: PingOneClient, id: string): Promise<LiveIdentityProvider | null> {
  const res = await client.request('GET', `/identityProviders/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch identity provider ${id}: ${pingOneErrorMessage(res)}`)
  }
  return parseJson<LiveIdentityProvider>(res.body)
}

/**
 * Build the create/update body for the type PingOne's `type` discriminator
 * selects. `name`/`enabled`/`type` and (when set) `registration` are common to
 * every type; everything else is type-specific. Throws on an unsupported type
 * - validate.ts already rejects these, so this is a defensive backstop.
 */
export function buildIdentityProviderBody(spec: IdentityProviderSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    enabled: spec.enabled,
    type: spec.type,
  }
  if (spec.description) body.description = spec.description
  if (spec.registrationPopulationId) {
    body.registration = { population: { id: spec.registrationPopulationId } }
  }

  switch (spec.type) {
    case 'FACEBOOK':
      body.appId = spec.socialClientId
      body.appSecret = spec.socialClientSecret
      break

    case 'PAYPAL':
      body.clientId = spec.socialClientId
      body.clientSecret = spec.socialClientSecret
      body.clientEnvironment = spec.paypalEnvironment
      break

    case 'MICROSOFT':
      body.clientId = spec.socialClientId
      body.clientSecret = spec.socialClientSecret
      if (spec.microsoftTenantId) body.tenantId = spec.microsoftTenantId
      break

    case 'GOOGLE':
    case 'GITHUB':
    case 'LINKEDIN_OIDC':
    case 'AMAZON':
    case 'TWITTER':
    case 'YAHOO':
      body.clientId = spec.socialClientId
      body.clientSecret = spec.socialClientSecret
      break

    case 'APPLE':
      body.clientId = spec.appleClientId
      body.clientSecretSigningKey = spec.appleClientSecretSigningKey
      body.keyId = spec.appleKeyId
      body.teamId = spec.appleTeamId
      break

    case 'OPENID_CONNECT':
      body.authorizationEndpoint = spec.oidcAuthorizationEndpoint
      body.clientId = spec.oidcClientId
      body.clientSecret = spec.oidcClientSecret
      body.issuer = spec.oidcIssuer
      body.jwksEndpoint = spec.oidcJwksEndpoint
      body.scopes = spec.oidcScopes
      body.tokenEndpoint = spec.oidcTokenEndpoint
      if (spec.oidcDiscoveryEndpoint) body.discoveryEndpoint = spec.oidcDiscoveryEndpoint
      if (spec.oidcUserInfoEndpoint) body.userInfoEndpoint = spec.oidcUserInfoEndpoint
      body.pkceMethod = spec.oidcPkceMethod || 'NONE'
      body.tokenEndpointAuthMethod = spec.oidcTokenEndpointAuthMethod || 'CLIENT_SECRET_BASIC'
      break

    case 'SAML': {
      body.idpEntityId = spec.samlIdpEntityId
      body.idpVerification = {
        certificates: spec.samlIdpVerificationCertificateIds.map((id) => ({ id })),
      }
      body.spEntityId = spec.samlSpEntityId
      body.ssoBinding = spec.samlSsoBinding
      body.ssoEndpoint = spec.samlSsoEndpoint
      body.authenticationRequestSigned = spec.samlAuthenticationRequestSigned
      body.sloBinding = spec.samlSloBinding || 'HTTP_POST'
      if (spec.samlSloEndpoint) body.sloEndpoint = spec.samlSloEndpoint
      if (spec.samlSpSigningKeyId) {
        body.spSigning = {
          key: { id: spec.samlSpSigningKeyId },
          ...(spec.samlSpSigningAlgorithm ? { algorithm: spec.samlSpSigningAlgorithm } : {}),
        }
      }
      break
    }

    default:
      throw new Error(`Unsupported identity provider type "${spec.type}"`)
  }

  return body
}

/**
 * Copy a live provider without the server-managed readOnly fields or any
 * secret field, so the result is safe to PUT back on rollback. See
 * IdentityProviderRollbackEntry.prior for why the secret strip is defensive
 * (PingOne never returns those fields in the first place).
 */
export function stripToSafePriorBody(idp: Record<string, unknown>): Record<string, unknown> {
  const dropped: readonly string[] = [...READONLY_IDENTITY_PROVIDER_FIELDS, ...SECRET_IDENTITY_PROVIDER_FIELDS]
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(idp)) {
    if (!dropped.includes(key)) out[key] = value
  }
  return out
}
