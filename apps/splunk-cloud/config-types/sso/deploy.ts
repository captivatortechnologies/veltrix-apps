import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  postForm,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
} from '../../lib/splunkRest'
import { extractSsoSpec, type SsoSpec } from './validate'

/**
 * Deploy the stack's SAML SSO identity-provider configuration over the Splunk
 * Cloud Platform REST API — NOT ACS, which has no SAML/OIDC IdP endpoint:
 *
 *   read:    GET  /services/authentication/providers/SAML/<name>
 *   create:  POST /services/authentication/providers/SAML          (name=<name>)
 *   update:  POST /services/authentication/providers/SAML/<name>
 *
 * on https://<stack>.splunkcloud.com:8089, authenticated with a Splunk
 * authentication token (Bearer). Requires that Splunk Support has opened port
 * 8089 and that this caller's IP is on the stack's `search-api` allow list —
 * both are named in every failure message (see lib/splunkRest.ts).
 *
 * Canvas → Splunk REST parameter mapping:
 *   providerName      → name              (path segment; sent as `name` on create)
 *   entityId          → entityId
 *   ssoUrl            → idpSSOUrl
 *   sloUrl            → idpSLOUrl
 *   signAuthnRequest  → signAuthnRequest
 *   roleAttribute     → roleAttribute
 *   realNameAttribute → realNameAttribute
 *   mailAttribute     → mailAttribute
 *
 * IdP CERTIFICATE IS NOT SENT. The SAML endpoint takes the certificate only as
 * `idpCertPath` — a file path on the Splunk server, which Splunk Cloud does not
 * expose — so an inline certificate cannot be pushed over REST. Any supplied
 * certificate is treated as write-only, never appears in messages/artifacts, and
 * the result message tells the operator to upload it in Splunk Web. This is a
 * real Splunk Cloud SAML limitation (see validate.ts).
 *
 * SCOPE: this defines the SAML PROVIDER. Making SAML the stack's active login
 * method is a separate global step ([authentication] authType=SAML, done in
 * Splunk Web) that this provider-scoped type does not perform.
 */

export const SAML_BASE_PATH = '/services/authentication/providers/SAML'

/** Non-secret REST parameters snapshotted from the live provider for rollback. */
const ROLLBACK_KEYS = [
  'entityId',
  'idpSSOUrl',
  'idpSLOUrl',
  'signAuthnRequest',
  'roleAttribute',
  'realNameAttribute',
  'mailAttribute',
] as const

export interface SsoRollbackState {
  /** The provider name (REST path segment) this deploy targeted. */
  providerName: string
  /** Whether a SAML provider by this name already existed before this deployment. */
  existed: boolean
  /** Prior non-secret REST values, captured only when the provider already existed. */
  prior?: Record<string, unknown>
}

/**
 * Deploy the SAML SSO provider configuration.
 *
 * The prior non-secret config is captured in rollbackData.previousState so a
 * rollback can restore it (or delete the provider we created). The certificate
 * is never read, sent, logged or returned.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const token = resolveRestToken(ctx.credential)
  if (!token) {
    return { success: false, message: REST_TOKEN_MISSING }
  }

  const spec = extractSsoSpec(ctx.canvas)
  if (!spec.providerName) {
    return { success: false, message: 'No SAML provider name to deploy — set the provider name on the canvas' }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const stack = resolveStackHost(ctx.component.hostname)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)
  const providerPath = `${SAML_BASE_PATH}/${encodeURIComponent(spec.providerName)}`

  try {
    // Read the current provider so rollback can restore it and so we know whether
    // to create (POST to the collection) or update (POST to the entity). A
    // connection/auth failure throws here rather than being mistaken for "the
    // provider does not exist".
    const existing = await getEntityContent(baseUrl, auth, providerPath, timeoutMs)
    const existed = existing !== null

    const rollbackState: SsoRollbackState = { providerName: spec.providerName, existed }
    if (existing) {
      const prior: Record<string, unknown> = {}
      for (const key of ROLLBACK_KEYS) {
        if (existing[key] !== undefined) prior[key] = existing[key]
      }
      rollbackState.prior = prior
    }

    const params = buildSamlParams(spec)
    if (existed) {
      await postForm(baseUrl, auth, providerPath, params, timeoutMs)
    } else {
      await postForm(baseUrl, auth, SAML_BASE_PATH, { name: spec.providerName, ...params }, timeoutMs)
    }

    const action = existed ? 'Updated' : 'Created'
    const certNote = spec.idpCertificate
      ? ' — the IdP certificate was NOT applied (the SAML REST endpoint accepts it only as a server file path, which Splunk Cloud does not expose): upload it in Splunk Web (Settings > Authentication Methods > SAML).'
      : ''
    const activationNote = spec.enabled
      ? ' This deploys the SAML provider definition only; make SAML the stack login method in Splunk Web (Settings > Authentication Methods) — this app does not flip the global auth scheme.'
      : ''

    return {
      success: true,
      message: `${action} SAML SSO provider "${spec.providerName}" on stack "${stack}" (entity "${spec.entityId}").${activationNote}${certNote}`,
      artifacts: {
        stack,
        endpoint: `${baseUrl}${providerPath}`,
        providerName: spec.providerName,
        entityId: spec.entityId,
        ssoUrl: spec.ssoUrl,
        sloUrl: spec.sloUrl || undefined,
        created: !existed,
        attributeMapping: {
          role: spec.roleAttribute || undefined,
          realName: spec.realNameAttribute || undefined,
          mail: spec.mailAttribute || undefined,
        },
        // Deliberately omits idpCertificate (write-only, never sent).
      },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `SAML SSO provider deployment to stack "${stack}" failed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { stack, providerName: spec.providerName },
    }
  }
}

/**
 * Map the spec's non-secret fields to Splunk SAML REST parameters. Only fields
 * the canvas actually declares are included — an omitted field is left untouched
 * on the provider. The IdP certificate is never included (see file header).
 */
export function buildSamlParams(
  spec: SsoSpec,
): Record<string, string | number | boolean | string[] | undefined | null> {
  const params: Record<string, string | number | boolean | string[] | undefined | null> = {
    entityId: spec.entityId,
    idpSSOUrl: spec.ssoUrl,
  }
  if (spec.sloUrl) params.idpSLOUrl = spec.sloUrl
  if (spec.signAuthnRequest !== undefined) {
    params.signAuthnRequest = spec.signAuthnRequest ? 'true' : 'false'
  }
  if (spec.roleAttribute) params.roleAttribute = spec.roleAttribute
  if (spec.realNameAttribute) params.realNameAttribute = spec.realNameAttribute
  if (spec.mailAttribute) params.mailAttribute = spec.mailAttribute
  return params
}

/**
 * Rebuild a REST payload from a rollback snapshot: the prior non-secret values
 * captured before the deploy, keyed by their live REST parameter names.
 */
export function buildRestorePayload(
  prior: Record<string, unknown>,
): Record<string, string | number | boolean | string[] | undefined | null> {
  const payload: Record<string, string | number | boolean | string[] | undefined | null> = {}
  for (const key of ROLLBACK_KEYS) {
    const value = prior[key]
    if (value === undefined || value === null) continue
    payload[key] = String(value)
  }
  return payload
}
