import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Splunk Cloud SAML SSO — validation + the spec extraction shared by
// deploy / rollback / healthCheck / driftDetect.
//
// SCOPE: SAML ONLY. A stack's single-sign-on identity provider is configured
// through the Splunk Cloud Platform REST API on the stack's management port
// 8089, at /services/authentication/providers/SAML/<name> (this is the same
// authentication.conf-backed `[<saml settings>]` stanza Splunk Enterprise uses,
// reached over REST). This is the SAME :8089 REST mechanism this app's `roles`,
// `users` and `authentication-tokens` types use — NOT ACS. ACS has no
// SAML/OIDC IdP endpoint (verified against the ACS v2 OpenAPI), so the previous
// ACS `/authentication/sso` path this type used did not exist.
//
// OIDC IS OUT OF SCOPE. Splunk does not expose an OIDC identity-provider REST
// endpoint analogous to authentication/providers/SAML — OIDC/OAuth SSO on the
// Splunk platform is configured separately (proxy / scripted auth) and cannot be
// modelled here honestly, so this type is SAML-only.
//
// IdP CERTIFICATE CAVEAT. The SAML provider endpoint takes the IdP signing
// certificate ONLY as `idpCertPath` — a FILE PATH on the Splunk server
// ($SPLUNK_HOME/etc/auth/idpCerts). There is no inline-certificate REST
// parameter, and Splunk Cloud gives no filesystem access, so a certificate
// pasted here CANNOT be pushed over REST: it must be uploaded through Splunk Web
// (Settings > Authentication Methods > SAML). The `idpCertificate` field is
// therefore OPTIONAL, kept only so the intended certificate can be recorded and
// shape-checked; validate() warns that it needs a manual Splunk Web upload and
// deploy() never sends it. This is a real Splunk Cloud SAML limitation, not a
// gap in this handler.
//
// Field key ⇄ Splunk REST parameter (authentication/providers/SAML):
//   providerName        ⇄  name           (the SAML settings stanza / path segment)
//   entityId            ⇄  entityId
//   ssoUrl              ⇄  idpSSOUrl
//   sloUrl              ⇄  idpSLOUrl
//   signAuthnRequest    ⇄  signAuthnRequest
//   roleAttribute       ⇄  roleAttribute
//   realNameAttribute   ⇄  realNameAttribute
//   mailAttribute       ⇄  mailAttribute
//   idpCertificate      ⇄  (none — manual Splunk Web upload; see above)
//
// A stack has exactly ONE SAML SSO configuration, so this is a single-object
// config (canvas.yaml pins minItems/maxItems to 1) rather than a repeatable list.
//
// Docs:
//  - Configure SAML SSO for other IdPs (settings: entityId, idpSSOUrl, idpSLOUrl,
//    idpCertPath, signAuthnRequest, roleAttribute/realNameAttribute/mailAttribute):
//    https://help.splunk.com/en/splunk-enterprise/administer/manage-users-and-security/10.4/use-saml-as-an-authentication-scheme-for-single-sign-on/configure-saml-sso-for-other-idps
//  - Configure SAML SSO using configuration files (authentication.conf [saml]
//    stanza + [authentication] authType=SAML global activation):
//    https://help.splunk.com/en/splunk-enterprise/administer/manage-users-and-security/9.4/perform-advanced-configuration-of-saml-authentication-in-splunk-enterprise/configure-saml-sso-using-configuration-files-on-splunk-enterprise
//  - REST access endpoint descriptions (authentication/providers/SAML):
//    https://help.splunk.com/en/splunk-enterprise/leverage-rest-apis/rest-api-reference/10.4/access-endpoints/access-endpoint-descriptions
// =============================================================================

/**
 * Splunk entity-name rules for the SAML provider stanza name: it is both a
 * config stanza name and a REST URL path segment, so it must begin with a letter
 * or digit and contain only letters, digits, dots, underscores and hyphens (no
 * spaces, slashes, colons or the reserved "."/"..").
 */
export const PROVIDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const MAX_PROVIDER_NAME_LENGTH = 100

/** Splunk's default SAML assertion attribute names, used when a mapping is blank. */
export const DEFAULT_ROLE_ATTRIBUTE = 'role'
export const DEFAULT_REALNAME_ATTRIBUTE = 'realName'
export const DEFAULT_MAIL_ATTRIBUTE = 'mail'

/** Does a value parse as an https:// URL (the only scheme an IdP endpoint may use)? */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Does a value parse as any http(s) URL? Used to tell "not a URL" from "insecure URL". */
function isHttpUrl(value: string): boolean {
  try {
    const proto = new URL(value).protocol
    return proto === 'https:' || proto === 'http:'
  } catch {
    return false
  }
}

/**
 * Does a value look like an X.509 certificate? Accepts a PEM block (the common
 * case) or a bare base64 DER blob. This is a shape check only — it never proves
 * the certificate is valid or trusted, which only the IdP handshake can.
 */
export function looksLikeCertificate(value: string): boolean {
  const v = value.trim()
  if (/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(v)) return true
  return v.length >= 100 && /^[A-Za-z0-9+/=\r\n]+$/.test(v)
}

/**
 * Coerce a canvas checkbox value to a boolean.
 *   - `undefined` → the field is absent/blank
 *   - boolean     → the coerced value
 * Checkboxes send real booleans; the string forms are accepted defensively.
 */
export function coerceBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return undefined
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface SsoSpec {
  sectionName: string
  /** SAML provider stanza name — the REST path segment (maps to `name`). */
  providerName: string
  /**
   * Whether this SAML provider is intended to be the stack's active login
   * method. Advisory only: the provider endpoint defines the IdP trust but does
   * NOT flip the stack's global auth scheme (that is a separate Splunk Web /
   * [authentication] step). Drives the lockout-risk warning.
   */
  enabled: boolean
  entityId: string
  ssoUrl: string
  sloUrl: string
  /** Sign AuthnRequests sent to the IdP. Undefined when the operator left it blank. */
  signAuthnRequest: boolean | undefined
  /** Write-only, optional: an IdP signing certificate (PEM). Never sent over REST. */
  idpCertificate: string
  roleAttribute: string
  realNameAttribute: string
  mailAttribute: string
}

/**
 * Shape of a SAML provider as returned by
 * GET /services/authentication/providers/SAML/{name} → entry[0].content.
 * Only non-secret fields are modelled — the IdP certificate is never read back.
 */
export interface LiveSamlProvider {
  entityId?: string
  idpSSOUrl?: string
  idpSLOUrl?: string
  signAuthnRequest?: boolean | string | number
  roleAttribute?: string
  realNameAttribute?: string
  mailAttribute?: string
}

function str(fields: Record<string, unknown>, key: string): string {
  const v = fields[key]
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Read the single SAML SSO configuration from the canvas. This config type is
 * single-object, so the spec comes from the first (and only) item; a spec with
 * empty fields is returned when the canvas is empty so callers stay total.
 */
export function extractSsoSpec(canvas: CanvasSnapshot): SsoSpec {
  const section = (canvas.sections ?? [])[0]
  const fields = section?.fields ?? {}
  return {
    sectionName: section?.name ?? 'sso',
    providerName: str(fields, 'providerName'),
    enabled: fields.enabled === true,
    entityId: str(fields, 'entityId'),
    ssoUrl: str(fields, 'ssoUrl'),
    sloUrl: str(fields, 'sloUrl'),
    signAuthnRequest: coerceBool(fields.signAuthnRequest),
    idpCertificate: str(fields, 'idpCertificate'),
    roleAttribute: str(fields, 'roleAttribute'),
    realNameAttribute: str(fields, 'realNameAttribute'),
    mailAttribute: str(fields, 'mailAttribute'),
  }
}

// --- Validate handler --------------------------------------------------------

/**
 * Validate the SAML SSO configuration: a provider name that satisfies Splunk's
 * entity-name rules, a present IdP entity ID, https IdP endpoint URLs, an
 * optional certificate shape, and safety rails — a lockout warning whenever SSO
 * is marked active, a warning when no role attribute mapping is declared (SSO
 * users would get no access), and a warning that a supplied certificate must be
 * uploaded through Splunk Web (it cannot be pushed over REST on Splunk Cloud).
 *
 * Never touches the network — the REST prerequisites (port 8089 open; caller IP
 * on the `search-api` allow list) are surfaced at deploy/health-check time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({
      field: 'sections',
      message: `A stack has exactly one SAML SSO configuration — got ${sections.length}. Declare a single configuration.`,
      code: 'multiple_configs',
    })
  }

  const spec = extractSsoSpec(ctx.canvas)
  const prefix = spec.sectionName

  // Provider name (the REST path segment / SAML settings stanza name)
  if (!spec.providerName) {
    errors.push({
      field: `${prefix}.providerName`,
      message: 'SAML provider name is required — it names the authentication/providers/SAML entity on the stack',
      code: 'required',
    })
  } else {
    if (!PROVIDER_NAME_RE.test(spec.providerName)) {
      errors.push({
        field: `${prefix}.providerName`,
        message:
          'SAML provider name must begin with a letter or digit and contain only letters, digits, dots, underscores and hyphens (no spaces, slashes or colons — it is a Splunk entity name and a REST path segment)',
        code: 'invalid_provider_name',
      })
    }
    if (spec.providerName.length > MAX_PROVIDER_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.providerName`,
        message: `SAML provider name must be ${MAX_PROVIDER_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }
  }

  // IdP entity ID (the IdP's unique identifier — maps to entityId)
  if (!spec.entityId) {
    errors.push({
      field: `${prefix}.entityId`,
      message: 'IdP entity ID is required (the unique identifier for the identity provider)',
      code: 'required',
    })
  }

  // SSO endpoint URL (required, must be https — maps to idpSSOUrl)
  if (!spec.ssoUrl) {
    errors.push({ field: `${prefix}.ssoUrl`, message: 'IdP SSO URL is required', code: 'required' })
  } else if (!isHttpUrl(spec.ssoUrl)) {
    errors.push({
      field: `${prefix}.ssoUrl`,
      message: `"${spec.ssoUrl}" is not a valid URL`,
      code: 'invalid_url',
    })
  } else if (!isHttpsUrl(spec.ssoUrl)) {
    errors.push({
      field: `${prefix}.ssoUrl`,
      message: 'IdP SSO URL must use https:// — an http endpoint would send SAML assertions in the clear',
      code: 'insecure_url',
    })
  }

  // SLO endpoint URL (optional, must be https when present — maps to idpSLOUrl)
  if (spec.sloUrl) {
    if (!isHttpUrl(spec.sloUrl)) {
      errors.push({
        field: `${prefix}.sloUrl`,
        message: `"${spec.sloUrl}" is not a valid URL`,
        code: 'invalid_url',
      })
    } else if (!isHttpsUrl(spec.sloUrl)) {
      errors.push({
        field: `${prefix}.sloUrl`,
        message: 'IdP SLO URL must use https://',
        code: 'insecure_url',
      })
    }
  }

  // IdP certificate — OPTIONAL. When supplied it is shape-checked, but it cannot
  // be applied over REST on Splunk Cloud (no inline param; idpCertPath is a
  // server file path), so it is warned rather than sent.
  if (spec.idpCertificate) {
    if (!looksLikeCertificate(spec.idpCertificate)) {
      errors.push({
        field: `${prefix}.idpCertificate`,
        message: 'IdP certificate does not look like a PEM certificate or base64 DER blob',
        code: 'invalid_certificate',
      })
    } else {
      warnings.push({
        field: `${prefix}.idpCertificate`,
        message:
          'The SAML provider REST endpoint accepts the IdP certificate only as a server file path (idpCertPath), which Splunk Cloud does not expose — this certificate will NOT be pushed by deploy. Upload it in Splunk Web (Settings > Authentication Methods > SAML).',
        code: 'cert_manual_upload',
      })
    }
  }

  // Attribute mappings — without a role mapping, authenticated users get no roles.
  if (!spec.roleAttribute) {
    warnings.push({
      field: `${prefix}.roleAttribute`,
      message: `No role attribute mapping declared — Splunk will look for the default "${DEFAULT_ROLE_ATTRIBUTE}" attribute. Without a matching assertion attribute, SSO users authenticate but receive no roles (no access).`,
      code: 'role_mapping_missing',
    })
  }

  // Lockout rail — activating SAML with a bad IdP config can stop every SSO user
  // from logging in. Deploy only defines the provider; activation is a separate
  // Splunk Web step, but the warning is the right place to flag the risk.
  if (spec.enabled) {
    warnings.push({
      field: `${prefix}.enabled`,
      message:
        'Marking SSO active: a misconfigured IdP can lock SSO users out of the stack. Keep a Splunk-native local admin login available and verify the IdP handshake before making SAML the stack login method (a separate Splunk Web step — deploy defines the provider only).',
      code: 'sso_lockout_risk',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
