import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- PingOne Identity Providers API constraints ------------------------------
// https://apidocs.pingidentity.com/pingone/platform/v1/api/#identity-providers
//
// GET/POST /identityProviders            - list ({ _embedded: { identityProviders: [...] } }) / create
// GET/PUT/DELETE /identityProviders/{id} - read / update / delete
//
// `type` discriminates the request/response body shape. This app models every
// type PingOne's own `EnumIdentityProviderExt` supports EXCEPT the deprecated
// "LINKEDIN" (superseded by "LINKEDIN_OIDC") and the internal "PING_ONE" type,
// which PingOne manages itself and never accepts on create.

/** A provider name is capped at 256 characters and must be unique in the environment. */
export const MAX_NAME_LENGTH = 256

export const IDENTITY_PROVIDER_TYPES = [
  'OPENID_CONNECT',
  'SAML',
  'GOOGLE',
  'MICROSOFT',
  'FACEBOOK',
  'GITHUB',
  'LINKEDIN_OIDC',
  'AMAZON',
  'APPLE',
  'PAYPAL',
  'TWITTER',
  'YAHOO',
] as const
export type IdentityProviderType = (typeof IDENTITY_PROVIDER_TYPES)[number]

/**
 * Every type whose credentials live in the canvas "Social / OAuth Credentials"
 * group (socialClientId/socialClientSecret) - Facebook and PayPal included,
 * even though their wire body uses different field names than a plain OAuth2
 * client (see buildIdentityProviderBody in deploy.ts).
 */
export const SOCIAL_CREDENTIAL_TYPES = [
  'GOOGLE',
  'MICROSOFT',
  'FACEBOOK',
  'GITHUB',
  'LINKEDIN_OIDC',
  'AMAZON',
  'PAYPAL',
  'TWITTER',
  'YAHOO',
] as const

export const PAYPAL_ENVIRONMENTS = ['live', 'sandbox'] as const
export const OIDC_TOKEN_ENDPOINT_AUTH_METHODS = ['CLIENT_SECRET_BASIC', 'CLIENT_SECRET_POST', 'NONE'] as const
export const OIDC_PKCE_METHODS = ['NONE', 'S256'] as const
export const SAML_BINDINGS = ['HTTP_POST', 'HTTP_REDIRECT'] as const
export const SAML_SIGNING_ALGORITHMS = [
  'SHA256withRSA',
  'SHA384withRSA',
  'SHA512withRSA',
  'SHA256withECDSA',
  'SHA384withECDSA',
  'SHA512withECDSA',
] as const

// --- Spec extraction shared by deploy / rollback / driftDetect / healthCheck -

export interface IdentityProviderSpec {
  sectionName: string
  /** Provider name - the logical identity deploy matches on. */
  name: string
  description?: string
  enabled: boolean
  /** Provider kind - discriminates which fields below apply. */
  type: string
  /** Population id for JIT provisioning; blank disables it (registration is omitted entirely). */
  registrationPopulationId?: string

  // Social / OAuth (also Facebook and PayPal, which reuse these two fields).
  socialClientId?: string
  socialClientSecret?: string
  microsoftTenantId?: string
  paypalEnvironment?: string

  // Apple.
  appleClientId?: string
  appleTeamId?: string
  appleKeyId?: string
  appleClientSecretSigningKey?: string

  // OpenID Connect.
  oidcIssuer?: string
  oidcAuthorizationEndpoint?: string
  oidcTokenEndpoint?: string
  oidcJwksEndpoint?: string
  oidcUserInfoEndpoint?: string
  oidcDiscoveryEndpoint?: string
  oidcClientId?: string
  oidcClientSecret?: string
  oidcScopes: string[]
  oidcTokenEndpointAuthMethod?: string
  oidcPkceMethod?: string

  // SAML.
  samlIdpEntityId?: string
  samlSpEntityId?: string
  samlSsoEndpoint?: string
  samlSsoBinding?: string
  samlIdpVerificationCertificateIds: string[]
  samlAuthenticationRequestSigned: boolean
  samlSloBinding?: string
  samlSloEndpoint?: string
  samlSpSigningKeyId?: string
  samlSpSigningAlgorithm?: string
}

/**
 * Shape of an identity provider returned by GET /identityProviders and
 * /identityProviders/{id}. Carries an index signature so server-managed
 * fields not modeled above (environment, createdAt, updatedAt, _links) remain
 * readable, and so per-type fields this app doesn't declare (e.g. a provider
 * created outside Veltrix) don't break the type. Secret fields
 * (clientSecret/appSecret/clientSecretSigningKey) are deliberately absent -
 * PingOne never returns them.
 */
export interface LiveIdentityProvider {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
  type?: string
  registration?: { population?: { id?: string } }
  clientId?: string
  appId?: string
  tenantId?: string
  clientEnvironment?: string
  keyId?: string
  teamId?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  jwksEndpoint?: string
  userInfoEndpoint?: string
  discoveryEndpoint?: string
  issuer?: string
  scopes?: string[]
  pkceMethod?: string
  tokenEndpointAuthMethod?: string
  idpEntityId?: string
  spEntityId?: string
  ssoBinding?: string
  ssoEndpoint?: string
  idpVerification?: { certificates?: Array<{ id?: string }> }
  authenticationRequestSigned?: boolean
  sloBinding?: string
  sloEndpoint?: string
  spSigning?: { key?: { id?: string }; algorithm?: string }
  environment?: unknown
  createdAt?: string
  updatedAt?: string
  _links?: unknown
  [key: string]: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Split a canvas `tags` value (array) or comma/newline string into trimmed items. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Each canvas item describes one PingOne identity provider. */
export function extractIdentityProviderSpecs(canvas: CanvasSnapshot): IdentityProviderSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: str(fields.description),
      enabled: bool(fields.enabled, true),
      type: typeof fields.type === 'string' ? fields.type.trim().toUpperCase() : '',
      registrationPopulationId: str(fields.registrationPopulationId),

      socialClientId: str(fields.socialClientId),
      socialClientSecret: str(fields.socialClientSecret),
      microsoftTenantId: str(fields.microsoftTenantId),
      paypalEnvironment: str(fields.paypalEnvironment)?.toLowerCase(),

      appleClientId: str(fields.appleClientId),
      appleTeamId: str(fields.appleTeamId),
      appleKeyId: str(fields.appleKeyId),
      appleClientSecretSigningKey: str(fields.appleClientSecretSigningKey),

      oidcIssuer: str(fields.oidcIssuer),
      oidcAuthorizationEndpoint: str(fields.oidcAuthorizationEndpoint),
      oidcTokenEndpoint: str(fields.oidcTokenEndpoint),
      oidcJwksEndpoint: str(fields.oidcJwksEndpoint),
      oidcUserInfoEndpoint: str(fields.oidcUserInfoEndpoint),
      oidcDiscoveryEndpoint: str(fields.oidcDiscoveryEndpoint),
      oidcClientId: str(fields.oidcClientId),
      oidcClientSecret: str(fields.oidcClientSecret),
      oidcScopes: splitList(fields.oidcScopes),
      oidcTokenEndpointAuthMethod: str(fields.oidcTokenEndpointAuthMethod),
      oidcPkceMethod: str(fields.oidcPkceMethod),

      samlIdpEntityId: str(fields.samlIdpEntityId),
      samlSpEntityId: str(fields.samlSpEntityId),
      samlSsoEndpoint: str(fields.samlSsoEndpoint),
      samlSsoBinding: str(fields.samlSsoBinding),
      samlIdpVerificationCertificateIds: splitList(fields.samlIdpVerificationCertificateIds),
      samlAuthenticationRequestSigned: bool(fields.samlAuthenticationRequestSigned, false),
      samlSloBinding: str(fields.samlSloBinding),
      samlSloEndpoint: str(fields.samlSloEndpoint),
      samlSpSigningKeyId: str(fields.samlSpSigningKeyId),
      samlSpSigningAlgorithm: str(fields.samlSpSigningAlgorithm),
    }
  })
}

/** True when `value` parses as an absolute http(s) URL (optionally https-only). */
function isUrl(value: string, httpsOnly: boolean): boolean {
  try {
    const url = new URL(value)
    return httpsOnly ? url.protocol === 'https:' : url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate identity-provider configurations against the PingOne Platform API.
 * Static only - it never contacts PingOne:
 *   - name is required, <= 256 chars, and unique within the canvas
 *   - type is required and one of the supported IDENTITY_PROVIDER_TYPES
 *   - per type, the fields PingOne requires on create/update are checked:
 *     social/Facebook/PayPal need a client id + secret (PayPal also needs its
 *     live/sandbox environment); Microsoft's tenant id is optional; Apple needs
 *     all four of client id/team id/key id/signing key; a custom OIDC provider
 *     needs issuer/authorization/token/jwks endpoints + client id/secret +
 *     scopes; a custom SAML provider needs idp/sp entity ids, an SSO endpoint
 *     and binding, and at least one verification certificate id
 * IdPs are SENSITIVE - a misconfigured provider can break federated sign-in.
 * The write-only client secret / app secret / Apple signing key are authored
 * here but are never drift-checked (PingOne never returns them).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIdentityProviderSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name - required, <= 256 chars, unique (case-insensitive)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Provider name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Provider name must be ${MAX_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate provider "${spec.name}" - each identity provider may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // type - required and in the supported enum
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Provider type is required', code: 'required' })
      continue
    }
    if (!(IDENTITY_PROVIDER_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Provider type must be one of: ${IDENTITY_PROVIDER_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
      continue
    }

    validateTypeSpecificFields(spec, prefix, errors)
  }

  return { valid: errors.length === 0, errors, warnings }
}

function validateTypeSpecificFields(
  spec: IdentityProviderSpec,
  prefix: string,
  errors: ValidationResult['errors'],
): void {
  const isFacebook = spec.type === 'FACEBOOK'

  if ((SOCIAL_CREDENTIAL_TYPES as readonly string[]).includes(spec.type)) {
    if (!spec.socialClientId) {
      errors.push({
        field: `${prefix}.socialClientId`,
        message: isFacebook ? 'App ID is required for Facebook' : 'Client ID is required for this provider type',
        code: 'required',
      })
    }
    if (!spec.socialClientSecret) {
      errors.push({
        field: `${prefix}.socialClientSecret`,
        message: isFacebook
          ? 'App Secret is required for Facebook'
          : 'Client Secret is required for this provider type',
        code: 'required',
      })
    }
  }

  if (spec.type === 'PAYPAL') {
    if (!spec.paypalEnvironment) {
      errors.push({
        field: `${prefix}.paypalEnvironment`,
        message: 'PayPal environment (live or sandbox) is required',
        code: 'required',
      })
    } else if (!(PAYPAL_ENVIRONMENTS as readonly string[]).includes(spec.paypalEnvironment)) {
      errors.push({
        field: `${prefix}.paypalEnvironment`,
        message: `PayPal environment must be one of: ${PAYPAL_ENVIRONMENTS.join(', ')}`,
        code: 'invalid_paypal_environment',
      })
    }
  }

  if (spec.type === 'APPLE') {
    const appleRequired: Array<[string, string | undefined, string]> = [
      ['appleClientId', spec.appleClientId, 'Services ID (Client ID)'],
      ['appleTeamId', spec.appleTeamId, 'Team ID'],
      ['appleKeyId', spec.appleKeyId, 'Key ID'],
      ['appleClientSecretSigningKey', spec.appleClientSecretSigningKey, 'Private Key (PEM)'],
    ]
    for (const [key, value, label] of appleRequired) {
      if (!value) {
        errors.push({ field: `${prefix}.${key}`, message: `${label} is required for Apple`, code: 'required' })
      }
    }
  }

  if (spec.type === 'OPENID_CONNECT') {
    validateOidc(spec, prefix, errors)
  }

  if (spec.type === 'SAML') {
    validateSaml(spec, prefix, errors)
  }
}

function validateOidc(spec: IdentityProviderSpec, prefix: string, errors: ValidationResult['errors']): void {
  if (!spec.oidcIssuer) {
    errors.push({ field: `${prefix}.oidcIssuer`, message: 'Issuer is required for OpenID Connect', code: 'required' })
  } else if (!isUrl(spec.oidcIssuer, true)) {
    errors.push({ field: `${prefix}.oidcIssuer`, message: 'Issuer must be an https URL', code: 'invalid_url' })
  }

  if (!spec.oidcAuthorizationEndpoint) {
    errors.push({
      field: `${prefix}.oidcAuthorizationEndpoint`,
      message: 'Authorization endpoint is required for OpenID Connect',
      code: 'required',
    })
  } else if (!isUrl(spec.oidcAuthorizationEndpoint, true)) {
    errors.push({
      field: `${prefix}.oidcAuthorizationEndpoint`,
      message: 'Authorization endpoint must be an https URL',
      code: 'invalid_url',
    })
  }

  if (!spec.oidcTokenEndpoint) {
    errors.push({
      field: `${prefix}.oidcTokenEndpoint`,
      message: 'Token endpoint is required for OpenID Connect',
      code: 'required',
    })
  } else if (!isUrl(spec.oidcTokenEndpoint, false)) {
    errors.push({
      field: `${prefix}.oidcTokenEndpoint`,
      message: 'Token endpoint must be a valid URL',
      code: 'invalid_url',
    })
  }

  if (!spec.oidcJwksEndpoint) {
    errors.push({
      field: `${prefix}.oidcJwksEndpoint`,
      message: 'JWKS endpoint is required for OpenID Connect',
      code: 'required',
    })
  } else if (!isUrl(spec.oidcJwksEndpoint, true)) {
    errors.push({ field: `${prefix}.oidcJwksEndpoint`, message: 'JWKS endpoint must be an https URL', code: 'invalid_url' })
  }

  if (!spec.oidcClientId) {
    errors.push({ field: `${prefix}.oidcClientId`, message: 'Client ID is required for OpenID Connect', code: 'required' })
  }
  if (!spec.oidcClientSecret) {
    errors.push({
      field: `${prefix}.oidcClientSecret`,
      message: 'Client Secret is required for OpenID Connect',
      code: 'required',
    })
  }
  if (spec.oidcScopes.length === 0) {
    errors.push({
      field: `${prefix}.oidcScopes`,
      message: 'At least one scope is required for OpenID Connect',
      code: 'required',
    })
  }

  if (spec.oidcTokenEndpointAuthMethod && !(OIDC_TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(spec.oidcTokenEndpointAuthMethod)) {
    errors.push({
      field: `${prefix}.oidcTokenEndpointAuthMethod`,
      message: `Token endpoint auth method must be one of: ${OIDC_TOKEN_ENDPOINT_AUTH_METHODS.join(', ')}`,
      code: 'invalid_token_endpoint_auth_method',
    })
  }
  if (spec.oidcPkceMethod && !(OIDC_PKCE_METHODS as readonly string[]).includes(spec.oidcPkceMethod)) {
    errors.push({
      field: `${prefix}.oidcPkceMethod`,
      message: `PKCE method must be one of: ${OIDC_PKCE_METHODS.join(', ')}`,
      code: 'invalid_pkce_method',
    })
  }
  if (spec.oidcUserInfoEndpoint && !isUrl(spec.oidcUserInfoEndpoint, false)) {
    errors.push({
      field: `${prefix}.oidcUserInfoEndpoint`,
      message: 'UserInfo endpoint must be a valid URL',
      code: 'invalid_url',
    })
  }
  if (spec.oidcDiscoveryEndpoint && !isUrl(spec.oidcDiscoveryEndpoint, false)) {
    errors.push({
      field: `${prefix}.oidcDiscoveryEndpoint`,
      message: 'Discovery endpoint must be a valid URL',
      code: 'invalid_url',
    })
  }
}

function validateSaml(spec: IdentityProviderSpec, prefix: string, errors: ValidationResult['errors']): void {
  if (!spec.samlIdpEntityId) {
    errors.push({ field: `${prefix}.samlIdpEntityId`, message: 'IdP Entity ID is required for SAML', code: 'required' })
  }
  if (!spec.samlSpEntityId) {
    errors.push({ field: `${prefix}.samlSpEntityId`, message: 'SP Entity ID is required for SAML', code: 'required' })
  }

  if (!spec.samlSsoEndpoint) {
    errors.push({ field: `${prefix}.samlSsoEndpoint`, message: 'SSO endpoint is required for SAML', code: 'required' })
  } else if (!isUrl(spec.samlSsoEndpoint, false)) {
    errors.push({ field: `${prefix}.samlSsoEndpoint`, message: 'SSO endpoint must be a valid URL', code: 'invalid_url' })
  }

  if (!spec.samlSsoBinding) {
    errors.push({ field: `${prefix}.samlSsoBinding`, message: 'SSO binding is required for SAML', code: 'required' })
  } else if (!(SAML_BINDINGS as readonly string[]).includes(spec.samlSsoBinding)) {
    errors.push({
      field: `${prefix}.samlSsoBinding`,
      message: `SSO binding must be one of: ${SAML_BINDINGS.join(', ')}`,
      code: 'invalid_binding',
    })
  }

  if (spec.samlIdpVerificationCertificateIds.length === 0) {
    errors.push({
      field: `${prefix}.samlIdpVerificationCertificateIds`,
      message: 'At least one IdP verification certificate id is required for SAML',
      code: 'required',
    })
  }

  if (spec.samlSloBinding && !(SAML_BINDINGS as readonly string[]).includes(spec.samlSloBinding)) {
    errors.push({
      field: `${prefix}.samlSloBinding`,
      message: `SLO binding must be one of: ${SAML_BINDINGS.join(', ')}`,
      code: 'invalid_binding',
    })
  }
  if (spec.samlSloEndpoint && !isUrl(spec.samlSloEndpoint, false)) {
    errors.push({ field: `${prefix}.samlSloEndpoint`, message: 'SLO endpoint must be a valid URL', code: 'invalid_url' })
  }
  if (
    spec.samlSpSigningAlgorithm &&
    !(SAML_SIGNING_ALGORITHMS as readonly string[]).includes(spec.samlSpSigningAlgorithm)
  ) {
    errors.push({
      field: `${prefix}.samlSpSigningAlgorithm`,
      message: `SP signing algorithm must be one of: ${SAML_SIGNING_ALGORITHMS.join(', ')}`,
      code: 'invalid_signing_algorithm',
    })
  }
}
