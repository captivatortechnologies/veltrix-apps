import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- PingOne Applications API constraints ------------------------------------
// https://apidocs.pingidentity.com/pingone/platform/v1/api/#applications
//
// GET/POST      /applications                - list ({ _embedded: { applications: [...] } }) / create
// GET/PUT/DELETE /applications/{id}           - read / update / delete
// GET/POST/DELETE /applications/{id}/secret   - the OIDC client secret sub-resource; NOT
//   managed by this config type (PingOne generates it server-side and returns it only
//   through this endpoint - write-only/excluded, exactly like okta-identity's `apps`
//   type treats credentials.oauthClient.client_secret).
//
// `protocol` (OPENID_CONNECT | SAML) and a protocol-specific application `type`
// are both required and both immutable in practice - converting a live
// application's protocol/type is not attempted by this config type; a mismatch
// on an existing match is treated the same as any other field and simply PUT
// with the newly declared values (PingOne itself will reject an unsupported
// transition). WORKER - the type this app's own connection authenticates as -
// is deliberately never offered as a canvas option, so it can never be
// declared here.

/** The two application protocols this config type manages. EXTERNAL_LINK and WSFED are out of scope. */
export const PROTOCOLS = ['OPENID_CONNECT', 'SAML'] as const
export type Protocol = (typeof PROTOCOLS)[number]

/** OIDC application types offered - WORKER is intentionally never included (see header). */
export const OIDC_TYPES = ['WEB_APP', 'NATIVE_APP', 'SINGLE_PAGE_APP', 'SERVICE'] as const
export type OidcType = (typeof OIDC_TYPES)[number]

/** SAML application types offered. */
export const SAML_TYPES = ['WEB_APP', 'CUSTOM_APP'] as const
export type SamlType = (typeof SAML_TYPES)[number]

/** OIDC grant types offered. TOKEN_EXCHANGE and CIBA are out of scope. */
export const GRANT_TYPES = [
  'AUTHORIZATION_CODE',
  'IMPLICIT',
  'REFRESH_TOKEN',
  'CLIENT_CREDENTIALS',
  'DEVICE_CODE',
] as const

/** OIDC response types offered. CODE cannot combine with TOKEN or ID_TOKEN (no hybrid flow). */
export const RESPONSE_TYPES = ['CODE', 'TOKEN', 'ID_TOKEN'] as const

/**
 * Token endpoint auth methods offered. PRIVATE_KEY_JWT is allowed as a raw
 * select option but its JWKS / JWKS URL configuration is not collected by
 * this app (see canvas.yaml) - CLIENT_SECRET_JWT is out of scope entirely.
 */
export const TOKEN_ENDPOINT_AUTH_METHODS = [
  'CLIENT_SECRET_BASIC',
  'CLIENT_SECRET_POST',
  'NONE',
  'PRIVATE_KEY_JWT',
] as const

/** PKCE enforcement levels. */
export const PKCE_ENFORCEMENT_LEVELS = ['OPTIONAL', 'REQUIRED', 'S256_REQUIRED'] as const

/** SAML single-logout bindings offered. */
export const SLO_BINDINGS = ['HTTP_POST', 'HTTP_REDIRECT'] as const

/** SAML IdP signing key algorithms offered. */
export const SIGNING_KEY_ALGORITHMS = [
  'SHA256withRSA',
  'SHA384withRSA',
  'SHA512withRSA',
  'SHA256withECDSA',
  'SHA384withECDSA',
  'SHA512withECDSA',
] as const

/** An application name is capped at 256 characters. */
export const MAX_APPLICATION_NAME_LENGTH = 256

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ApplicationSpec {
  sectionName: string
  /** Application name - the logical identity deploy matches on. */
  name: string
  description?: string
  enabled: boolean
  protocol: string
  loginPageUrl?: string
  hiddenFromAppPortal: boolean

  // OIDC-only (protocol === OPENID_CONNECT)
  oidcType?: string
  redirectUris: string[]
  postLogoutRedirectUris: string[]
  grantTypes: string[]
  responseTypes: string[]
  tokenEndpointAuthMethod?: string
  pkceEnforcement?: string
  refreshTokenDurationSeconds?: number
  homePageUrl?: string

  // SAML-only (protocol === SAML)
  samlType?: string
  acsUrls: string[]
  spEntityId?: string
  assertionDurationSeconds?: number
  assertionSignedEnabled: boolean
  responseIsSigned: boolean
  nameIdFormat?: string
  defaultTargetUrl?: string
  sloBinding?: string
  sloEndpoint?: string
  idpSigningKeyId?: string
  idpSigningKeyAlgorithm?: string
}

/**
 * Shape of an application returned by GET /applications and /applications/{id}.
 * Carries an index signature so server-managed fields not modeled above
 * (environment, createdAt, updatedAt, _links, clientId, icon, accessControl)
 * remain readable.
 */
export interface LiveApplication {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
  protocol?: string
  type?: string
  loginPageUrl?: string
  hiddenFromAppPortal?: boolean
  redirectUris?: string[]
  postLogoutRedirectUris?: string[]
  grantTypes?: string[]
  responseTypes?: string[]
  tokenEndpointAuthMethod?: string
  pkceEnforcement?: string
  refreshTokenDuration?: number
  homePageUrl?: string
  clientId?: string
  acsUrls?: string[]
  assertionDuration?: number
  spEntityId?: string
  assertionSignedEnabled?: boolean
  responseIsSigned?: boolean
  nameIdFormat?: string
  defaultTargetUrl?: string
  sloBinding?: string
  sloEndpoint?: string
  idpSigningKey?: { algorithm?: string; keyId?: string }
  environment?: unknown
  createdAt?: string
  updatedAt?: string
  icon?: unknown
  accessControl?: unknown
  _links?: unknown
  [key: string]: unknown
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

const trimmedString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** Each canvas item describes one PingOne application. */
export function extractApplicationSpecs(canvas: CanvasSnapshot): ApplicationSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: trimmedString(fields.description),
      enabled: fields.enabled !== false,
      protocol: typeof fields.protocol === 'string' ? fields.protocol.trim().toUpperCase() : '',
      loginPageUrl: trimmedString(fields.loginPageUrl),
      hiddenFromAppPortal: fields.hiddenFromAppPortal === true,

      oidcType: trimmedString(fields.oidcType)?.toUpperCase(),
      redirectUris: splitList(fields.redirectUris),
      postLogoutRedirectUris: splitList(fields.postLogoutRedirectUris),
      grantTypes: splitList(fields.grantTypes).map((v) => v.toUpperCase()),
      responseTypes: splitList(fields.responseTypes).map((v) => v.toUpperCase()),
      tokenEndpointAuthMethod: trimmedString(fields.tokenEndpointAuthMethod)?.toUpperCase(),
      pkceEnforcement: trimmedString(fields.pkceEnforcement)?.toUpperCase(),
      refreshTokenDurationSeconds: finiteNumber(fields.refreshTokenDurationSeconds),
      homePageUrl: trimmedString(fields.homePageUrl),

      samlType: trimmedString(fields.samlType)?.toUpperCase(),
      acsUrls: splitList(fields.acsUrls),
      spEntityId: trimmedString(fields.spEntityId),
      assertionDurationSeconds: finiteNumber(fields.assertionDurationSeconds),
      assertionSignedEnabled: fields.assertionSignedEnabled !== false,
      responseIsSigned: fields.responseIsSigned === true,
      nameIdFormat: trimmedString(fields.nameIdFormat),
      defaultTargetUrl: trimmedString(fields.defaultTargetUrl),
      sloBinding: trimmedString(fields.sloBinding)?.toUpperCase(),
      sloEndpoint: trimmedString(fields.sloEndpoint),
      idpSigningKeyId: trimmedString(fields.idpSigningKeyId),
      idpSigningKeyAlgorithm: trimmedString(fields.idpSigningKeyAlgorithm),
    }
  })
}

/**
 * Resolve the API's `type` discriminator from the protocol-specific canvas
 * field (`oidcType` for OPENID_CONNECT, `samlType` for SAML). Returns
 * undefined when the protocol is unrecognized or the matching field is unset
 * - callers treat that as "cannot build a body yet" (validate already
 * requires it).
 */
export function resolveApplicationType(spec: ApplicationSpec): string | undefined {
  if (spec.protocol === 'OPENID_CONNECT') return spec.oidcType
  if (spec.protocol === 'SAML') return spec.samlType
  return undefined
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate application configurations against the PingOne Applications API.
 * Static only - it never contacts PingOne:
 *   - name is required, <= 256 chars, and unique within the canvas
 *   - protocol is required and one of OPENID_CONNECT | SAML
 *   - when OIDC: oidcType is required and a supported type (never WORKER - it
 *     is not offered as a canvas option, so it cannot appear here); grantTypes
 *     is non-empty and every value is supported; tokenEndpointAuthMethod is
 *     required and supported (PRIVATE_KEY_JWT is allowed but warned about -
 *     its JWKS is not collected here); responseTypes values are supported and
 *     CODE cannot combine with TOKEN or ID_TOKEN
 *   - when SAML: samlType is required and supported; acsUrls is non-empty;
 *     spEntityId is required; assertionDurationSeconds is required and > 0;
 *     sloBinding / idpSigningKeyAlgorithm, when set, are supported values;
 *     idpSigningKeyId and idpSigningKeyAlgorithm must be set together
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractApplicationSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name - required, <= 256 chars, unique
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Application name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_APPLICATION_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Application name must be ${MAX_APPLICATION_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate application "${spec.name}" - each application may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // protocol - required and supported
    if (!spec.protocol) {
      errors.push({ field: `${prefix}.protocol`, message: 'Protocol is required', code: 'required' })
    } else if (!(PROTOCOLS as readonly string[]).includes(spec.protocol)) {
      errors.push({
        field: `${prefix}.protocol`,
        message: `Protocol must be one of: ${PROTOCOLS.join(', ')} (EXTERNAL_LINK and WSFED are out of scope)`,
        code: 'invalid_protocol',
      })
    }

    if (spec.protocol === 'OPENID_CONNECT') {
      validateOidc(spec, prefix, errors, warnings)
    } else if (spec.protocol === 'SAML') {
      validateSaml(spec, prefix, errors, warnings)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

function validateOidc(
  spec: ApplicationSpec,
  prefix: string,
  errors: ValidationResult['errors'],
  warnings: ValidationResult['warnings'],
): void {
  if (!spec.oidcType) {
    errors.push({ field: `${prefix}.oidcType`, message: 'Application Type is required for an OIDC application', code: 'required' })
  } else if (!(OIDC_TYPES as readonly string[]).includes(spec.oidcType)) {
    errors.push({
      field: `${prefix}.oidcType`,
      message: `Application Type must be one of: ${OIDC_TYPES.join(', ')}`,
      code: 'invalid_oidc_type',
    })
  }

  if (spec.grantTypes.length === 0) {
    errors.push({ field: `${prefix}.grantTypes`, message: 'At least one grant type is required for an OIDC application', code: 'required' })
  } else {
    const invalid = spec.grantTypes.filter((g) => !(GRANT_TYPES as readonly string[]).includes(g))
    if (invalid.length > 0) {
      errors.push({
        field: `${prefix}.grantTypes`,
        message: `Unsupported grant type(s): ${invalid.join(', ')}. Supported: ${GRANT_TYPES.join(', ')} (TOKEN_EXCHANGE and CIBA are out of scope)`,
        code: 'invalid_grant_type',
      })
    }
  }

  if (!spec.tokenEndpointAuthMethod) {
    errors.push({
      field: `${prefix}.tokenEndpointAuthMethod`,
      message: 'Token Endpoint Auth Method is required for an OIDC application',
      code: 'required',
    })
  } else if (!(TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(spec.tokenEndpointAuthMethod)) {
    errors.push({
      field: `${prefix}.tokenEndpointAuthMethod`,
      message: `Token Endpoint Auth Method must be one of: ${TOKEN_ENDPOINT_AUTH_METHODS.join(', ')}`,
      code: 'invalid_auth_method',
    })
  } else if (spec.tokenEndpointAuthMethod === 'PRIVATE_KEY_JWT') {
    warnings.push({
      field: `${prefix}.tokenEndpointAuthMethod`,
      message:
        'PRIVATE_KEY_JWT requires a JWKS or JWKS URL, which this app does not collect - configure the signing key in the PingOne admin console after deploy.',
      code: 'jwks_unsupported',
    })
  }

  if (spec.responseTypes.length > 0) {
    const invalid = spec.responseTypes.filter((r) => !(RESPONSE_TYPES as readonly string[]).includes(r))
    if (invalid.length > 0) {
      errors.push({
        field: `${prefix}.responseTypes`,
        message: `Unsupported response type(s): ${invalid.join(', ')}. Supported: ${RESPONSE_TYPES.join(', ')}`,
        code: 'invalid_response_type',
      })
    }
    if (spec.responseTypes.includes('CODE') && (spec.responseTypes.includes('TOKEN') || spec.responseTypes.includes('ID_TOKEN'))) {
      errors.push({
        field: `${prefix}.responseTypes`,
        message: 'Response Types cannot combine CODE with TOKEN or ID_TOKEN - the hybrid flow is not supported',
        code: 'no_hybrid_flow',
      })
    }
  }

  if (spec.pkceEnforcement && !(PKCE_ENFORCEMENT_LEVELS as readonly string[]).includes(spec.pkceEnforcement)) {
    errors.push({
      field: `${prefix}.pkceEnforcement`,
      message: `PKCE Enforcement must be one of: ${PKCE_ENFORCEMENT_LEVELS.join(', ')}`,
      code: 'invalid_pkce_enforcement',
    })
  }

  if (
    spec.refreshTokenDurationSeconds !== undefined &&
    (spec.refreshTokenDurationSeconds < 60 || spec.refreshTokenDurationSeconds > 2147483647)
  ) {
    errors.push({
      field: `${prefix}.refreshTokenDurationSeconds`,
      message: 'Refresh Token Duration must be between 60 and 2147483647 seconds',
      code: 'invalid_range',
    })
  }
}

function validateSaml(
  spec: ApplicationSpec,
  prefix: string,
  errors: ValidationResult['errors'],
  warnings: ValidationResult['warnings'],
): void {
  if (!spec.samlType) {
    errors.push({ field: `${prefix}.samlType`, message: 'Application Type is required for a SAML application', code: 'required' })
  } else if (!(SAML_TYPES as readonly string[]).includes(spec.samlType)) {
    errors.push({
      field: `${prefix}.samlType`,
      message: `Application Type must be one of: ${SAML_TYPES.join(', ')}`,
      code: 'invalid_saml_type',
    })
  }

  if (spec.acsUrls.length === 0) {
    errors.push({ field: `${prefix}.acsUrls`, message: 'At least one ACS URL is required for a SAML application', code: 'required' })
  }

  if (!spec.spEntityId) {
    errors.push({ field: `${prefix}.spEntityId`, message: 'SP Entity ID is required for a SAML application', code: 'required' })
  }

  if (spec.assertionDurationSeconds === undefined) {
    errors.push({
      field: `${prefix}.assertionDurationSeconds`,
      message: 'Assertion Duration is required for a SAML application',
      code: 'required',
    })
  } else if (spec.assertionDurationSeconds <= 0) {
    errors.push({
      field: `${prefix}.assertionDurationSeconds`,
      message: 'Assertion Duration must be a positive number of seconds',
      code: 'invalid_range',
    })
  }

  if (spec.sloBinding && !(SLO_BINDINGS as readonly string[]).includes(spec.sloBinding)) {
    errors.push({
      field: `${prefix}.sloBinding`,
      message: `Single Logout Binding must be one of: ${SLO_BINDINGS.join(', ')}`,
      code: 'invalid_slo_binding',
    })
  }

  if (spec.idpSigningKeyAlgorithm && !(SIGNING_KEY_ALGORITHMS as readonly string[]).includes(spec.idpSigningKeyAlgorithm)) {
    errors.push({
      field: `${prefix}.idpSigningKeyAlgorithm`,
      message: `IdP Signing Key Algorithm must be one of: ${SIGNING_KEY_ALGORITHMS.join(', ')}`,
      code: 'invalid_signing_algorithm',
    })
  }

  if (spec.idpSigningKeyId && !spec.idpSigningKeyAlgorithm) {
    errors.push({
      field: `${prefix}.idpSigningKeyAlgorithm`,
      message: 'IdP Signing Key Algorithm is required when IdP Signing Key ID is set',
      code: 'required',
    })
  } else if (spec.idpSigningKeyAlgorithm && !spec.idpSigningKeyId) {
    warnings.push({
      field: `${prefix}.idpSigningKeyId`,
      message: 'IdP Signing Key Algorithm is set without an IdP Signing Key ID - it will be ignored',
      code: 'signing_key_ignored',
    })
  }
}
