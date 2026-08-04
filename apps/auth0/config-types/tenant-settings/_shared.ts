// Shared helpers for the Auth0 Tenant Settings config type (deploy + rollback +
// drift). GET/PATCH /api/v2/tenants/settings has a huge surface; this config
// type curates a safe, well-documented subset (the same judgment call this
// app already makes for resource-servers' signing-algorithm allowlist and
// connections' strategy allowlist) rather than exposing every tenant setting.
//
// Top-level scalar/array fields are ALWAYS included in the PATCH body (even as
// '' / [] when blank) — this config type owns those fields outright, so
// clearing the canvas field clears the live setting too. `flags` is different:
// Auth0's tenant PATCH does a genuine partial-merge on `flags`, so only the
// flag keys actually present in the keyvalue map are ever sent — an empty or
// absent flags map means "touch no flags", never "clear all flags".
//
// Verified against the official Auth0 Management API v2 (Tenants):
//   https://auth0.com/docs/api/management/v2/tenants

import { readKeyValueMap, readOptionalInt, readString, readStringArray } from '../../lib/fields'

/** Documented tenant flags this config type manages — an intentional allowlist. */
export const TENANT_FLAG_KEYS = new Set([
  'allow_legacy_delegation_grant_types',
  'allow_legacy_ro_grant_types',
  'allow_legacy_tokeninfo_endpoint',
  'dashboard_insights_view',
  'dashboard_log_streams_next',
  'disable_clickjack_protection_headers',
  'disable_fields_map_fix',
  'disable_management_api_sms_obfuscation',
  'enable_adfs_waad_email_verification',
  'enable_apis_section',
  'enable_client_connections',
  'enable_custom_domain_in_emails',
  'enable_dynamic_client_registration',
  'enable_idtoken_api2',
  'enable_legacy_logs_search_v2',
  'enable_legacy_profile',
  'enable_pipeline2',
  'enable_public_signup_user_exists_error',
  'enable_sso',
  'mfa_show_factor_list_on_enrollment',
  'no_disclose_enterprise_connections',
  'remove_alg_from_jwks',
  'revoke_refresh_token_grant',
  'use_scope_descriptions_for_consent',
])

/** The subset of tenant settings this config type manages, as sent to PATCH. */
export interface TenantSettingsBody {
  friendly_name: string
  support_email: string
  support_url: string
  picture_url: string
  default_audience: string
  default_directory: string
  default_redirection_uri: string
  sandbox_version: string
  enabled_locales: string[]
  allowed_logout_urls: string[]
  session_lifetime?: number
  idle_session_lifetime?: number
  flags?: Record<string, boolean>
}

/** Parse the `flags` keyvalue map to a boolean record; non-"true"/"false" values are dropped (validate.ts rejects them). */
export function parseFlags(value: unknown): Record<string, boolean> {
  const raw = readKeyValueMap(value)
  const out: Record<string, boolean> = {}
  for (const [key, v] of Object.entries(raw)) {
    if (v === 'true') out[key] = true
    else if (v === 'false') out[key] = false
  }
  return out
}

/** Build the managed PATCH body from canvas fields. See the file header for the flags-vs-scalar policy. */
export function buildTenantSettingsBody(fields: Record<string, unknown>): TenantSettingsBody {
  const body: TenantSettingsBody = {
    friendly_name: readString(fields.friendly_name),
    support_email: readString(fields.support_email),
    support_url: readString(fields.support_url),
    picture_url: readString(fields.picture_url),
    default_audience: readString(fields.default_audience),
    default_directory: readString(fields.default_directory),
    default_redirection_uri: readString(fields.default_redirection_uri),
    sandbox_version: readString(fields.sandbox_version),
    enabled_locales: readStringArray(fields.enabled_locales),
    allowed_logout_urls: readStringArray(fields.allowed_logout_urls),
  }

  const sessionLifetime = readOptionalInt(fields.session_lifetime)
  if (sessionLifetime !== undefined && sessionLifetime > 0) body.session_lifetime = sessionLifetime

  const idleSessionLifetime = readOptionalInt(fields.idle_session_lifetime)
  if (idleSessionLifetime !== undefined && idleSessionLifetime > 0) body.idle_session_lifetime = idleSessionLifetime

  const flags = parseFlags(fields.flags)
  if (Object.keys(flags).length > 0) body.flags = flags

  return body
}
