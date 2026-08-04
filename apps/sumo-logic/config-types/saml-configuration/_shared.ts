// Shared helpers for the Sumo Logic SAML Configuration config type
// (deploy + rollback + drift + validate).
//
// A SAML configuration is a flat record { id?, configurationName, issuer,
// x509cert1..3, spInitiatedLoginEnabled, authnRequestUrl, onDemandProvisioning
// Enabled (an OBJECT whose mere presence turns the feature on — not a
// boolean), rolesAttribute, emailAttribute, logoutEnabled, logoutUrl,
// debugMode, signAuthnRequest, disableRequestedAuthnContext,
// isRedirectBinding }. UNLIKE every other list endpoint in this app, GET
// /saml/identityProviders returns a BARE ARRAY — no { data: [...] } envelope,
// no pagination.
//
// ⚠ HIGH BLAST RADIUS: this configures how users sign in to the ENTIRE
// organization. A wrong issuer/certificate/authnRequestUrl can lock out every
// SSO-only user. Deploy and drift treat this the same as every other config
// type (upsert by name, full pipeline), but validate.ts always surfaces a
// prominent warning.
//   API: https://www.sumologic.com/help/docs/api/saml-configuration-management/
//   Verified against the official Sumo Logic OpenAPI spec
//   (SamlIdentityProvider / SamlIdentityProviderRequest / OnDemandProvisioningInfo,
//   api.sumologic.com/docs/sumologic-api.yaml).

/** One Sumo Logic SAML identity provider configuration. */
export interface SamlConfiguration {
  id?: string
  configurationName: string
  issuer: string
  x509cert1: string
  x509cert2?: string
  x509cert3?: string
  spInitiatedLoginEnabled?: boolean
  authnRequestUrl?: string
  onDemandProvisioningEnabled?: { firstNameAttribute: string; lastNameAttribute: string; onDemandProvisioningRoles: string[] } | null
  rolesAttribute?: string
  emailAttribute?: string
  logoutEnabled?: boolean
  logoutUrl?: string
  debugMode?: boolean
  signAuthnRequest?: boolean
  disableRequestedAuthnContext?: boolean
  isRedirectBinding?: boolean
  assertionConsumerUrl?: string
  entityId?: string
  [key: string]: unknown
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a checkbox/string value to a boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = s(value).toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/** Split a canvas `tags` value into a trimmed, de-duplicated list of non-empty strings. */
export function toStringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((v) => s(v)) : s(value).split(',').map((v) => v.trim())
  const out: string[] = []
  for (const v of raw) if (v && !out.includes(v)) out.push(v)
  return out
}

/** Find a live SAML configuration by name (case-insensitive, trimmed) — the identity. */
export function findSamlConfiguration(configs: SamlConfiguration[], configurationName: string): SamlConfiguration | null {
  const n = configurationName.trim().toLowerCase()
  if (!n) return null
  return configs.find((c) => s(c.configurationName).toLowerCase() === n) ?? null
}

/** Build the create/update request body (SamlIdentityProviderRequest) from canvas fields. */
export function buildSamlConfigurationBody(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    configurationName: s(fields.configurationName),
    issuer: s(fields.issuer),
    x509cert1: s(fields.x509cert1),
    x509cert2: s(fields.x509cert2),
    x509cert3: s(fields.x509cert3),
    spInitiatedLoginEnabled: normalizeBool(fields.spInitiatedLoginEnabled),
    authnRequestUrl: s(fields.authnRequestUrl),
    rolesAttribute: s(fields.rolesAttribute),
    emailAttribute: s(fields.emailAttribute),
    logoutEnabled: normalizeBool(fields.logoutEnabled),
    logoutUrl: s(fields.logoutUrl),
    debugMode: normalizeBool(fields.debugMode),
    signAuthnRequest: normalizeBool(fields.signAuthnRequest),
    disableRequestedAuthnContext: normalizeBool(fields.disableRequestedAuthnContext),
    isRedirectBinding: normalizeBool(fields.isRedirectBinding),
  }
  if (normalizeBool(fields.onDemandProvisioningEnabled)) {
    body.onDemandProvisioningEnabled = {
      firstNameAttribute: s(fields.onDemandFirstNameAttribute),
      lastNameAttribute: s(fields.onDemandLastNameAttribute),
      onDemandProvisioningRoles: toStringList(fields.onDemandProvisioningRoles),
    }
  }
  return body
}
