import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage, type PingOneClient } from '../../lib/pingOne'
import { extractApplicationSpecs, resolveApplicationType, type ApplicationSpec, type LiveApplication } from './validate'

export interface ApplicationRollbackEntry {
  name: string
  existed: boolean
  /** The application id PingOne assigns - the rollback key (never the name). */
  id?: string
  /** Prior application body with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/**
 * Server-managed fields PingOne returns on an application but that must never
 * be sent back on a PUT: `clientId` is server-assigned (read-only), `icon`
 * and `accessControl` are managed elsewhere, and the rest are the usual
 * environment/timestamps/HAL bookkeeping.
 */
export const READONLY_APPLICATION_FIELDS = [
  'id',
  'environment',
  'createdAt',
  'updatedAt',
  '_links',
  'clientId',
  'icon',
  'accessControl',
] as const

/**
 * Deploy applications to a PingOne environment via the Applications API. NO
 * UPSERT exists, so for each declared application:
 *   - GET  /applications              - list (paginated) and match by name
 *   - PUT  /applications/{id}         - update an existing application (capture prior body)
 *   - POST /applications              - create a missing application (capture the new id)
 *
 * A matched (existing) application is only ever UPDATED in place; deploy
 * never deletes an application that is not declared in the canvas. The
 * client secret sub-resource (`/applications/{id}/secret`) is never touched -
 * PingOne generates and manages it independently of the application object.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, environmentId } = built

  const specs = extractApplicationSpecs(ctx.canvas).filter((s) => s.name && s.protocol)
  const rollbackState: ApplicationRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const body = buildApplicationBody(spec)
      const existing = await findApplication(client, spec.name)

      if (existing && existing.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: stripReadOnlyApplicationFields(existing),
        })

        const res = await client.request('PUT', `/applications/${existing.id}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to update application "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/applications', { body })
        if (!res.ok) {
          throw new Error(`Failed to create application "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
        const created = parseJson<LiveApplication>(res.body)
        if (!created?.id) {
          throw new Error(`Application "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} application(s) to PingOne environment ${environmentId}: ${deployed.join(', ')}. Client secrets are managed separately in PingOne and were not touched.`,
      artifacts: { environmentId, deployedApplications: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Application deployment failed after ${deployed.length} of ${specs.length} application(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { environmentId, deployedApplications: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * Find an application by exact name across the paginated application list;
 * null when absent. PingOne enforces name uniqueness within an environment
 * server-side, so - unlike Okta's non-unique app label - a single match is
 * always sufficient here.
 */
export async function findApplication(client: PingOneClient, name: string): Promise<LiveApplication | null> {
  const res = await client.getAll<LiveApplication>('/applications', 'applications')
  if (!res.ok) {
    throw new Error(
      `Failed to list applications while resolving "${name}": ${pingOneErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
      })}`,
    )
  }
  return res.items.find((a) => a.name === name) ?? null
}

/** Fetch a single application by id; null on 404. */
export async function getApplicationById(client: PingOneClient, id: string): Promise<LiveApplication | null> {
  const res = await client.request('GET', `/applications/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch application ${id}: ${pingOneErrorMessage(res)}`)
  }
  return parseJson<LiveApplication>(res.body)
}

/**
 * Build the create/update body. `name`, `enabled`, `protocol` and the
 * resolved `type` always ship; every other common field is included only
 * when set. Only the fields belonging to the declared protocol are ever
 * sent - the OIDC and SAML field sets are mutually exclusive on the wire.
 */
export function buildApplicationBody(spec: ApplicationSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    enabled: spec.enabled,
    protocol: spec.protocol,
    type: resolveApplicationType(spec),
  }
  if (spec.description) body.description = spec.description
  if (spec.loginPageUrl) body.loginPageUrl = spec.loginPageUrl
  if (spec.hiddenFromAppPortal) body.hiddenFromAppPortal = spec.hiddenFromAppPortal

  if (spec.protocol === 'OPENID_CONNECT') {
    if (spec.redirectUris.length > 0) body.redirectUris = spec.redirectUris
    if (spec.postLogoutRedirectUris.length > 0) body.postLogoutRedirectUris = spec.postLogoutRedirectUris
    body.grantTypes = spec.grantTypes
    if (spec.responseTypes.length > 0) body.responseTypes = spec.responseTypes
    body.tokenEndpointAuthMethod = spec.tokenEndpointAuthMethod
    if (spec.pkceEnforcement) body.pkceEnforcement = spec.pkceEnforcement
    if (spec.refreshTokenDurationSeconds !== undefined) body.refreshTokenDuration = spec.refreshTokenDurationSeconds
    if (spec.homePageUrl) body.homePageUrl = spec.homePageUrl
  } else if (spec.protocol === 'SAML') {
    body.acsUrls = spec.acsUrls
    body.assertionDuration = spec.assertionDurationSeconds
    body.spEntityId = spec.spEntityId
    body.assertionSignedEnabled = spec.assertionSignedEnabled
    body.responseIsSigned = spec.responseIsSigned
    if (spec.nameIdFormat) body.nameIdFormat = spec.nameIdFormat
    if (spec.defaultTargetUrl) body.defaultTargetUrl = spec.defaultTargetUrl
    if (spec.sloBinding) body.sloBinding = spec.sloBinding
    if (spec.sloEndpoint) body.sloEndpoint = spec.sloEndpoint
    if (spec.idpSigningKeyId && spec.idpSigningKeyAlgorithm) {
      body.idpSigningKey = { algorithm: spec.idpSigningKeyAlgorithm, keyId: spec.idpSigningKeyId }
    }
  }

  return body
}

/** Copy a live application without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyApplicationFields(app: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(app)) {
    if (!(READONLY_APPLICATION_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
