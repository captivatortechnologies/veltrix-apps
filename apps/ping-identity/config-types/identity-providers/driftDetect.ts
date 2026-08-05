import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, stableStringify } from '../../lib/pingOne'
import { findIdentityProvider } from './deploy'
import { extractIdentityProviderSpecs, type IdentityProviderSpec, type LiveIdentityProvider } from './validate'

/**
 * Detect drift between the deployed identity-provider configuration and the
 * live PingOne environment. Each declared provider is re-found by name; then
 * `enabled`, `type` and every NON-secret field this app models for its type
 * are compared. Severity is 'critical' for the fields PingOne requires to
 * create/update that type (an IdP is broken without them) and 'warning' for
 * optional, supplementary fields.
 *
 * NEVER diffed: clientSecret / appSecret / clientSecretSigningKey. PingOne
 * stores these write-only and never returns them on a GET, so there is
 * nothing to compare them against - they are written only at deploy time.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractIdentityProviderSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)

  for (const spec of specs) {
    try {
      const live = await findIdentityProvider(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      compareCommonFields(diffs, spec, live)
      compareTypeFields(diffs, spec, live)
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function push(
  diffs: DriftDiff[],
  field: string,
  expected: unknown,
  actual: unknown,
  severity: DriftDiff['severity'],
): void {
  diffs.push({ field, expected: expected ?? 'not set', actual: actual ?? 'not set', severity })
}

/** Diff a scalar; no-op when `expected` is undefined (field not authored/applicable). */
function diffScalar(
  diffs: DriftDiff[],
  field: string,
  expected: unknown,
  actual: unknown,
  severity: DriftDiff['severity'],
): void {
  if (expected === undefined) return
  if (expected !== (actual ?? undefined)) push(diffs, field, expected, actual, severity)
}

/** Diff two string arrays as sets (order-insensitive); no-op when `expected` is empty. */
function diffArray(
  diffs: DriftDiff[],
  field: string,
  expected: string[],
  actual: string[] | undefined,
  severity: DriftDiff['severity'],
): void {
  if (expected.length === 0) return
  const expectedKey = stableStringify([...expected].sort())
  const actualList = Array.isArray(actual) ? actual : []
  const actualKey = stableStringify([...actualList].sort())
  if (expectedKey !== actualKey) push(diffs, field, expected, actualList, severity)
}

function compareCommonFields(diffs: DriftDiff[], spec: IdentityProviderSpec, live: LiveIdentityProvider): void {
  diffScalar(diffs, `${spec.name}.type`, spec.type, live.type, 'critical')
  diffScalar(diffs, `${spec.name}.enabled`, spec.enabled, live.enabled === true, 'critical')
  diffScalar(
    diffs,
    `${spec.name}.registrationPopulationId`,
    spec.registrationPopulationId,
    live.registration?.population?.id,
    'warning',
  )
}

function compareTypeFields(diffs: DriftDiff[], spec: IdentityProviderSpec, live: LiveIdentityProvider): void {
  const name = spec.name

  switch (spec.type) {
    case 'FACEBOOK':
      diffScalar(diffs, `${name}.appId`, spec.socialClientId, live.appId, 'critical')
      break

    case 'PAYPAL':
      diffScalar(diffs, `${name}.clientId`, spec.socialClientId, live.clientId, 'critical')
      diffScalar(diffs, `${name}.clientEnvironment`, spec.paypalEnvironment, live.clientEnvironment, 'critical')
      break

    case 'MICROSOFT':
      diffScalar(diffs, `${name}.clientId`, spec.socialClientId, live.clientId, 'critical')
      diffScalar(diffs, `${name}.tenantId`, spec.microsoftTenantId, live.tenantId, 'warning')
      break

    case 'GOOGLE':
    case 'GITHUB':
    case 'LINKEDIN_OIDC':
    case 'AMAZON':
    case 'TWITTER':
    case 'YAHOO':
      diffScalar(diffs, `${name}.clientId`, spec.socialClientId, live.clientId, 'critical')
      break

    case 'APPLE':
      diffScalar(diffs, `${name}.clientId`, spec.appleClientId, live.clientId, 'critical')
      diffScalar(diffs, `${name}.teamId`, spec.appleTeamId, live.teamId, 'critical')
      diffScalar(diffs, `${name}.keyId`, spec.appleKeyId, live.keyId, 'critical')
      break

    case 'OPENID_CONNECT':
      diffScalar(diffs, `${name}.authorizationEndpoint`, spec.oidcAuthorizationEndpoint, live.authorizationEndpoint, 'critical')
      diffScalar(diffs, `${name}.issuer`, spec.oidcIssuer, live.issuer, 'critical')
      diffScalar(diffs, `${name}.jwksEndpoint`, spec.oidcJwksEndpoint, live.jwksEndpoint, 'critical')
      diffScalar(diffs, `${name}.tokenEndpoint`, spec.oidcTokenEndpoint, live.tokenEndpoint, 'critical')
      diffScalar(diffs, `${name}.clientId`, spec.oidcClientId, live.clientId, 'critical')
      diffArray(diffs, `${name}.scopes`, spec.oidcScopes, live.scopes, 'critical')
      diffScalar(diffs, `${name}.userInfoEndpoint`, spec.oidcUserInfoEndpoint, live.userInfoEndpoint, 'warning')
      diffScalar(diffs, `${name}.discoveryEndpoint`, spec.oidcDiscoveryEndpoint, live.discoveryEndpoint, 'warning')
      diffScalar(diffs, `${name}.pkceMethod`, spec.oidcPkceMethod || 'NONE', live.pkceMethod, 'warning')
      diffScalar(
        diffs,
        `${name}.tokenEndpointAuthMethod`,
        spec.oidcTokenEndpointAuthMethod || 'CLIENT_SECRET_BASIC',
        live.tokenEndpointAuthMethod,
        'warning',
      )
      break

    case 'SAML': {
      diffScalar(diffs, `${name}.idpEntityId`, spec.samlIdpEntityId, live.idpEntityId, 'critical')
      diffScalar(diffs, `${name}.spEntityId`, spec.samlSpEntityId, live.spEntityId, 'critical')
      diffScalar(diffs, `${name}.ssoEndpoint`, spec.samlSsoEndpoint, live.ssoEndpoint, 'critical')
      diffScalar(diffs, `${name}.ssoBinding`, spec.samlSsoBinding, live.ssoBinding, 'critical')

      const liveCertIds = (live.idpVerification?.certificates ?? [])
        .map((c) => c?.id)
        .filter((id): id is string => typeof id === 'string')
      diffArray(diffs, `${name}.idpVerificationCertificateIds`, spec.samlIdpVerificationCertificateIds, liveCertIds, 'critical')

      diffScalar(
        diffs,
        `${name}.authenticationRequestSigned`,
        spec.samlAuthenticationRequestSigned,
        live.authenticationRequestSigned === true,
        'warning',
      )
      diffScalar(diffs, `${name}.sloBinding`, spec.samlSloBinding || 'HTTP_POST', live.sloBinding, 'warning')
      diffScalar(diffs, `${name}.sloEndpoint`, spec.samlSloEndpoint, live.sloEndpoint, 'warning')
      diffScalar(diffs, `${name}.spSigningKeyId`, spec.samlSpSigningKeyId, live.spSigning?.key?.id, 'warning')
      diffScalar(diffs, `${name}.spSigningAlgorithm`, spec.samlSpSigningAlgorithm, live.spSigning?.algorithm, 'warning')
      break
    }

    default:
      break
  }
}
