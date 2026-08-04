// Shared helpers for the Auth0 Custom Domains config type (deploy + rollback +
// drift).
//
// Custom domains put Universal Login on the operator's own hostname —
// GET/POST /api/v2/custom-domains and GET/PATCH/DELETE
// /api/v2/custom-domains/{id}. The Management API keys a custom domain on the
// server-assigned `id`, so this config type upserts by DOMAIN (unique per
// tenant, one row per hostname). `domain` and `type` are set at creation and
// are NOT changed on update, so the PATCH body omits both.
//
// IMPORTANT LIMITATION: a newly created custom domain comes back
// `pending_verification` and requires a manual DNS/CNAME (or TXT) proof plus a
// `POST /custom-domains/{id}/verify` call. This config type intentionally does
// NOT automate that verification step — no config-as-code account credentials
// can prove DNS ownership on the operator's behalf. Deploy only creates/updates
// the domain record; verification is a manual follow-up outside this pipeline.
//
// Unlike every other list endpoint in this app, GET /custom-domains is NOT
// paginated (Auth0 caps a tenant at a small number of custom domains), so
// deploy/drift read it with a plain `getJson`, not `listAllPages`.
//
// Verified against the official Auth0 Management API v2 (Custom Domains):
//   https://auth0.com/docs/api/management/v2/custom-domains/post-custom-domains
//   https://auth0.com/docs/api/management/v2/custom-domains/patch-custom-domains-by-id

import { readKeyValueMap, readOptionalString, readString } from '../../lib/fields'

/** Certificate management types Auth0 accepts for a custom domain. */
export const CUSTOM_DOMAIN_TYPES = new Set(['auth0_managed_certs', 'self_managed_certs'])

/** TLS policies Auth0 accepts. "" means "leave to Auth0's default". */
export const TLS_POLICIES = new Set(['', 'compatible', 'recommended'])

/** One custom domain as returned by the Management API. */
export interface Auth0CustomDomain {
  id?: string
  domain?: string
  type?: string
  status?: string
  primary?: boolean
  tls_policy?: string
  custom_client_ip_header?: string
  domain_metadata?: Record<string, string>
  [key: string]: unknown
}

/** The create body — domain + type are only sent when creating (immutable thereafter). */
export interface CustomDomainCreateBody {
  domain: string
  type: string
  tls_policy?: string
  custom_client_ip_header?: string
  domain_metadata?: Record<string, string>
}

/** The update body — domain and type are omitted (immutable). */
export interface CustomDomainUpdateBody {
  tls_policy?: string
  custom_client_ip_header?: string
  domain_metadata?: Record<string, string>
}

/**
 * A domain value is plausibly a bare hostname: non-empty, no scheme, no path,
 * and containing at least one dot. Deliberately loose (not a full RFC 1035
 * validator) — Auth0 itself is the source of truth on acceptance.
 */
export function looksLikeHostname(domain: string): boolean {
  const d = domain.trim()
  if (!d) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(d)) return false
  if (d.includes('/')) return false
  if (!d.includes('.')) return false
  return true
}

/** Find a live custom domain by domain (case-sensitive, trimmed) — the upsert identity. */
export function findCustomDomainByDomain(list: Auth0CustomDomain[], domain: string): Auth0CustomDomain | null {
  const d = domain.trim()
  if (!d) return null
  return list.find((c) => String(c.domain ?? '').trim() === d) ?? null
}

function domainMetadataFromFields(fields: Record<string, unknown>): Record<string, string> {
  return readKeyValueMap(fields.domain_metadata)
}

/** Build the create body from canvas fields (domain + type included). */
export function buildCustomDomainCreateBody(fields: Record<string, unknown>): CustomDomainCreateBody {
  const body: CustomDomainCreateBody = {
    domain: readString(fields.domain),
    type: readString(fields.type),
  }
  const tlsPolicy = readOptionalString(fields.tls_policy)
  if (tlsPolicy) body.tls_policy = tlsPolicy
  const ipHeader = readOptionalString(fields.custom_client_ip_header)
  if (ipHeader) body.custom_client_ip_header = ipHeader
  const metadata = domainMetadataFromFields(fields)
  if (Object.keys(metadata).length > 0) body.domain_metadata = metadata
  return body
}

/** Build the update body from canvas fields (domain + type omitted — immutable). */
export function buildCustomDomainUpdateBody(fields: Record<string, unknown>): CustomDomainUpdateBody {
  const body: CustomDomainUpdateBody = {}
  const tlsPolicy = readOptionalString(fields.tls_policy)
  if (tlsPolicy) body.tls_policy = tlsPolicy
  const ipHeader = readOptionalString(fields.custom_client_ip_header)
  if (ipHeader) body.custom_client_ip_header = ipHeader
  const metadata = domainMetadataFromFields(fields)
  if (Object.keys(metadata).length > 0) body.domain_metadata = metadata
  return body
}

/** Capture the prior managed state of a live custom domain for rollback. */
export function snapshotCustomDomain(domain: Auth0CustomDomain): CustomDomainUpdateBody {
  const body: CustomDomainUpdateBody = {
    custom_client_ip_header: typeof domain.custom_client_ip_header === 'string' ? domain.custom_client_ip_header : '',
    domain_metadata: domain.domain_metadata && typeof domain.domain_metadata === 'object' ? domain.domain_metadata : {},
  }
  if (typeof domain.tls_policy === 'string' && domain.tls_policy) body.tls_policy = domain.tls_policy
  return body
}
