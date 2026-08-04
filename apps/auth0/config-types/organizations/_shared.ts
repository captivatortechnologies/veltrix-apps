// Shared helpers for the Auth0 Organizations config type (deploy + rollback +
// drift). Organizations are GET/POST /api/v2/organizations and
// GET/PATCH/DELETE /api/v2/organizations/{id}. The Management API keys an
// organization on the server-assigned `id`, so this config type upserts by
// organization NAME (Auth0 enforces a unique name per tenant); `name` is set at
// creation and is NOT changed on update, so the PATCH body omits it.
//
// A separate sub-resource manages which connections members can sign in with:
//   GET    /api/v2/organizations/{id}/enabled_connections                list
//   POST   /api/v2/organizations/{id}/enabled_connections                add one
//   PATCH  /api/v2/organizations/{id}/enabled_connections/{connectionId} update flags
//   DELETE /api/v2/organizations/{id}/enabled_connections/{connectionId} remove
// (see connections.ts for the network calls; this file only parses/diffs the
// declared list, mirroring the roles config type's permissions reconciliation).
//
// Verified against the official Auth0 Management API v2 (Organizations):
//   https://auth0.com/docs/api/management/v2/organizations/post-organizations
//   https://auth0.com/docs/api/management/v2/organizations/patch-organizations-by-id
//   https://auth0.com/docs/api/management/v2/organizations/post-enabled-connections-to-organization

import { parseJsonObject, readOptionalString, readString } from '../../lib/fields'

/** Third-party (non-first-party) client access modes Auth0 accepts on an organization. */
export const THIRD_PARTY_CLIENT_ACCESS = new Set(['', 'allow', 'block'])

/** Enabled-connection flags this config type authors, parsed from the textarea line format. */
export const ENABLED_CONNECTION_FLAGS = new Set(['assign_membership_on_login', 'is_signup_enabled', 'show_as_button'])

/** One organization as returned by the Management API. */
export interface Auth0Organization {
  id?: string
  name?: string
  display_name?: string
  branding?: { logo_url?: string; colors?: { primary?: string; page_background?: string } }
  metadata?: Record<string, string>
  third_party_client_access?: string
  token_quota?: Record<string, unknown>
  [key: string]: unknown
}

/** The create body — `name` is only sent when creating (immutable thereafter). */
export interface OrganizationCreateBody {
  name: string
  display_name?: string
  branding?: { logo_url?: string; colors?: { primary?: string; page_background?: string } }
  metadata?: Record<string, string>
  third_party_client_access?: string
  token_quota?: Record<string, unknown>
}

/** The update body — `name` omitted (immutable). */
export type OrganizationUpdateBody = Omit<OrganizationCreateBody, 'name'>

/** One declared enabled-connection entry (identity is `connectionId`). */
export interface EnabledConnectionSpec {
  connectionId: string
  assignMembershipOnLogin: boolean
  isSignupEnabled: boolean
  showAsButton: boolean
}

/** Find a live organization by name (case-sensitive, trimmed) — the upsert identity. */
export function findOrganizationByName(list: Auth0Organization[], name: string): Auth0Organization | null {
  const n = name.trim()
  if (!n) return null
  return list.find((o) => String(o.name ?? '').trim() === n) ?? null
}

function brandingFromFields(fields: Record<string, unknown>): Auth0Organization['branding'] | undefined {
  const logoUrl = readOptionalString(fields.logo_url)
  const primary = readOptionalString(fields.colors_primary)
  const pageBackground = readOptionalString(fields.colors_page_background)
  if (logoUrl === undefined && primary === undefined && pageBackground === undefined) return undefined
  const branding: NonNullable<Auth0Organization['branding']> = {}
  if (logoUrl !== undefined) branding.logo_url = logoUrl
  if (primary !== undefined || pageBackground !== undefined) {
    branding.colors = {}
    if (primary !== undefined) branding.colors.primary = primary
    if (pageBackground !== undefined) branding.colors.page_background = pageBackground
  }
  return branding
}

function tokenQuotaFromFields(fields: Record<string, unknown>): Record<string, unknown> | undefined {
  const parsed = parseJsonObject(fields.token_quota)
  if (!parsed.ok || Object.keys(parsed.value).length === 0) return undefined
  return parsed.value
}

function metadataFromFields(fields: Record<string, unknown>): Record<string, string> | undefined {
  const raw = fields.metadata
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = key.trim()
    if (k) out[k] = String(value ?? '')
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Build the fields common to create + update from canvas fields. */
function commonBody(fields: Record<string, unknown>): OrganizationUpdateBody {
  const body: OrganizationUpdateBody = {}
  const displayName = readOptionalString(fields.display_name)
  if (displayName !== undefined) body.display_name = displayName
  const branding = brandingFromFields(fields)
  if (branding !== undefined) body.branding = branding
  const metadata = metadataFromFields(fields)
  if (metadata !== undefined) body.metadata = metadata
  const access = readString(fields.third_party_client_access)
  if (access) body.third_party_client_access = access
  const tokenQuota = tokenQuotaFromFields(fields)
  if (tokenQuota !== undefined) body.token_quota = tokenQuota
  return body
}

/** Build the create body from canvas fields (name included). */
export function buildOrganizationCreateBody(fields: Record<string, unknown>): OrganizationCreateBody {
  return { name: readString(fields.name), ...commonBody(fields) }
}

/** Build the update body from canvas fields (name omitted — immutable). */
export function buildOrganizationUpdateBody(fields: Record<string, unknown>): OrganizationUpdateBody {
  return commonBody(fields)
}

/** Capture the prior managed state of a live organization for rollback. */
export function snapshotOrganization(org: Auth0Organization): OrganizationUpdateBody {
  const body: OrganizationUpdateBody = {
    display_name: typeof org.display_name === 'string' ? org.display_name : '',
    metadata: org.metadata && typeof org.metadata === 'object' ? org.metadata : {},
  }
  if (org.branding) body.branding = org.branding
  if (typeof org.third_party_client_access === 'string' && org.third_party_client_access) {
    body.third_party_client_access = org.third_party_client_access
  }
  if (org.token_quota && typeof org.token_quota === 'object') body.token_quota = org.token_quota
  return body
}

/**
 * Parse the enabled-connections textarea into a de-duplicated list (last entry
 * for a given connection id wins). Each line is `<connection_id>` or
 * `<connection_id>|<comma-separated flags>` — flags are a subset of
 * assign_membership_on_login, is_signup_enabled, show_as_button; any other token
 * is ignored (validate.ts reports it).
 */
export function parseEnabledConnections(value: unknown): EnabledConnectionSpec[] {
  const lines = typeof value === 'string' ? value.split(/[\r\n]+/) : Array.isArray(value) ? value.map((v) => String(v ?? '')) : []
  const byId = new Map<string, EnabledConnectionSpec>()
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const [idPart, flagsPart] = trimmed.split('|')
    const connectionId = idPart.trim()
    if (!connectionId) continue
    const flags = new Set(
      (flagsPart ?? '')
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean),
    )
    byId.set(connectionId, {
      connectionId,
      assignMembershipOnLogin: flags.has('assign_membership_on_login'),
      isSignupEnabled: flags.has('is_signup_enabled'),
      showAsButton: flags.has('show_as_button'),
    })
  }
  return [...byId.values()]
}

/** Two enabled-connection specs are equal when every field matches. */
export function sameEnabledConnection(a: EnabledConnectionSpec, b: EnabledConnectionSpec): boolean {
  return (
    a.connectionId === b.connectionId &&
    a.assignMembershipOnLogin === b.assignMembershipOnLogin &&
    a.isSignupEnabled === b.isSignupEnabled &&
    a.showAsButton === b.showAsButton
  )
}
