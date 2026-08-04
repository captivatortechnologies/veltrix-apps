// =============================================================================
// Shared types, GraphQL documents and helpers for the Twingate DNS Filtering
// Profiles config type — used by validate / deploy / rollback / driftDetect /
// healthCheck.
//
// A DNS Filtering Profile controls website access via DNS for the Groups it
// is assigned to (allow/deny domain lists, content/security/privacy category
// blocking, and a fallback method). Requires DNS filtering to be enabled on
// the tenant's plan.
//
// `dnsFilteringProfileCreate` accepts ONLY `name` — every other field
// (priority, domains, fallback method, groups, category configs) is set via
// a SEPARATE `dnsFilteringProfileUpdate` call. This app's deploy therefore
// always creates-then-immediately-updates a new profile, never a single
// create-with-full-spec call (confirmed via terraform-provider-twingate:
// `dnsFilteringProfileCreate(name: $name)` vs the much larger
// `dnsFilteringProfileUpdate(id, name, priority, allowedDomains, deniedDomains,
// fallbackMethod, groups, privacyCategoryConfig, securityCategoryConfig,
// contentCategoryConfig)`).
//
// `allowedDomains`/`deniedDomains` are sent as flat domain-string lists
// (full-replacement, like this app's other tag-list fields) — Terraform's own
// `is_authoritative` merge-preserving behavior is a client-side-only concept
// in that provider, never sent to the GraphQL API, so this app does not model
// it (declarative full-replace only, consistent with the rest of this app).
//
// GraphQL facts verified against:
//   - https://www.twingate.com/docs/api-overview (endpoint, auth, rate limits)
//   - https://github.com/Twingate/terraform-provider-twingate — the exact
//     mutation variable sets (twingate/internal/client/query/dns-filtering-
//     profile-{create,update,delete}.go), the full field list including every
//     category flag (twingate/internal/client/query/dns-filtering-profile-
//     read.go: PrivacyCategoryConfig/SecurityCategoryConfig/ContentCategoryConfig)
//     and the FallbackMethod enum (twingate/internal/model/dns-filtering-
//     profile.go: AUTO/STRICT), plus its own resource docs
//     (docs/resources/dns_filtering_profile.md) for the human-facing behavior.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const FALLBACK_METHODS = ['STRICT', 'AUTO'] as const

/** `ContentCategoryConfig` flags — confirmed via terraform-provider-twingate's model.go / read.go. */
export const CONTENT_CATEGORY_FLAGS = [
  { key: 'blockGambling', label: 'Gambling' },
  { key: 'blockDating', label: 'Dating' },
  { key: 'blockAdultContent', label: 'Adult content' },
  { key: 'blockSocialMedia', label: 'Social media' },
  { key: 'blockGames', label: 'Games' },
  { key: 'blockStreaming', label: 'Streaming' },
  { key: 'blockPiracy', label: 'Piracy' },
  { key: 'enableYoutubeRestrictedMode', label: 'YouTube Restricted Mode' },
  { key: 'enableSafeSearch', label: 'Safe Search' },
] as const

/** `SecurityCategoryConfig` flags. */
export const SECURITY_CATEGORY_FLAGS = [
  { key: 'enableThreatIntelligenceFeeds', label: 'Threat intelligence feeds' },
  { key: 'enableGoogleSafeBrowsing', label: 'Google Safe Browsing' },
  { key: 'blockCryptojacking', label: 'Cryptojacking' },
  { key: 'blockIdnHomographs', label: 'IDN homograph attacks' },
  { key: 'blockTyposquatting', label: 'Typosquatting' },
  { key: 'blockDnsRebinding', label: 'DNS rebinding' },
  { key: 'blockNewlyRegisteredDomains', label: 'Newly registered domains' },
  { key: 'blockDomainGenerationAlgorithms', label: 'Domain generation algorithms (DGA)' },
  { key: 'blockParkedDomains', label: 'Parked domains' },
] as const

/** `PrivacyCategoryConfig` flags. */
export const PRIVACY_CATEGORY_FLAGS = [
  { key: 'blockAffiliate', label: 'Affiliate links' },
  { key: 'blockDisguisedTrackers', label: 'Disguised trackers' },
  { key: 'blockAdsAndTrackers', label: 'Ads and trackers' },
] as const

export type CategoryFlagKey = string

export interface DnsFilteringProfileSpec {
  itemName: string
  name: string
  priority: number
  fallbackMethod: string
  allowedDomains: string[]
  deniedDomains: string[]
  groupNames: string[]
  contentFlags: string[]
  securityFlags: string[]
  privacyFlags: string[]
}

/** A named reference (Group) as returned by the light groups list query. */
export interface NamedRef {
  id?: string
  name?: string
}

/** The profile's logical identity: its name (case-insensitive, trimmed). */
export function profileKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Read a canvas value that may be a `tags`/`multiselect` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Parse a canvas number field, falling back when absent/invalid. */
export function readNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

export function extractDnsFilteringProfileSpecs(canvas: CanvasSnapshot): DnsFilteringProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      itemName: item.name,
      name: str(fields.name),
      priority: readNumber(fields.priority, 1),
      fallbackMethod: str(fields.fallback_method) || 'STRICT',
      allowedDomains: strList(fields.allowed_domains),
      deniedDomains: strList(fields.denied_domains),
      groupNames: strList(fields.group_names),
      contentFlags: strList(fields.content_categories),
      securityFlags: strList(fields.security_categories),
      privacyFlags: strList(fields.privacy_categories),
    }
  })
}

// --- GraphQL documents (verified — see file header for sources) ----------------

/** List DNS Filtering Profiles (light shape, for matching by name). */
export const LIST_DNS_FILTERING_PROFILES_QUERY = `
query ListDnsFilteringProfiles($first: Int, $after: String) {
  dnsFilteringProfiles(first: $first, after: $after) {
    edges {
      node {
        id
        name
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

/** List Groups (light shape) — `group_names` are resolved to ids by name. */
export const LIST_GROUPS_QUERY = `
query ListGroupsForDnsFilteringProfiles($first: Int, $after: String) {
  groups(first: $first, after: $after) {
    edges {
      node {
        id
        name
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

/** Read a single profile's full managed state (for update-diffing + rollback restore). */
export const GET_DNS_FILTERING_PROFILE_QUERY = `
query GetDnsFilteringProfile($id: ID!) {
  dnsFilteringProfile(id: $id) {
    id
    name
    priority
    fallbackMethod
    allowedDomains
    deniedDomains
    groups(first: 200) {
      edges {
        node {
          id
          name
        }
      }
    }
    privacyCategoryConfig {
      blockAffiliate
      blockDisguisedTrackers
      blockAdsAndTrackers
    }
    securityCategoryConfig {
      enableThreatIntelligenceFeeds
      enableGoogleSafeBrowsing
      blockCryptojacking
      blockIdnHomographs
      blockTyposquatting
      blockDnsRebinding
      blockNewlyRegisteredDomains
      blockDomainGenerationAlgorithms
      blockParkedDomains
    }
    contentCategoryConfig {
      blockGambling
      blockDating
      blockAdultContent
      blockSocialMedia
      blockGames
      blockStreaming
      blockPiracy
      enableYoutubeRestrictedMode
      enableSafeSearch
    }
  }
}`

/** Create only sets `name` — every other field is applied via a follow-up update. */
export const CREATE_DNS_FILTERING_PROFILE_MUTATION = `
mutation DnsFilteringProfileCreate($name: String!) {
  dnsFilteringProfileCreate(name: $name) {
    ok
    error
    entity {
      id
    }
  }
}`

// FLAG (unverified): the terraform-provider-twingate source confirms every
// FIELD/ARGUMENT name below (dns-filtering-profile-update.go's graphql tag),
// but that provider builds its query via a Go struct-tag reflection client
// (hasura/go-graphql-client) that never has to spell out each variable's
// declared GraphQL INPUT TYPE NAME as literal SDL text — so the exact type
// names below (DNSFilteringFallbackMethod / PrivacyCategoryConfigInput /
// SecurityCategoryConfigInput / ContentCategoryConfigInput) are a reasonable,
// but not byte-for-byte confirmed, inference from the Go type names. A wrong
// type name fails LOUDLY (a GraphQL "unknown type" validation error surfaced
// via transportError/errors on the first deploy) rather than silently — verify
// against a live Twingate tenant (or its schema introspection) before
// depending on this config type in production.
export const UPDATE_DNS_FILTERING_PROFILE_MUTATION = `
mutation DnsFilteringProfileUpdate(
  $id: ID!
  $name: String
  $priority: Float
  $allowedDomains: [String!]
  $deniedDomains: [String!]
  $fallbackMethod: DNSFilteringFallbackMethod
  $groups: [ID!]
  $privacyCategoryConfig: PrivacyCategoryConfigInput
  $securityCategoryConfig: SecurityCategoryConfigInput
  $contentCategoryConfig: ContentCategoryConfigInput
) {
  dnsFilteringProfileUpdate(
    id: $id
    name: $name
    priority: $priority
    allowedDomains: $allowedDomains
    deniedDomains: $deniedDomains
    fallbackMethod: $fallbackMethod
    groups: $groups
    privacyCategoryConfig: $privacyCategoryConfig
    securityCategoryConfig: $securityCategoryConfig
    contentCategoryConfig: $contentCategoryConfig
  ) {
    ok
    error
    entity {
      id
    }
  }
}`

export const DELETE_DNS_FILTERING_PROFILE_MUTATION = `
mutation DnsFilteringProfileDelete($id: ID!) {
  dnsFilteringProfileDelete(id: $id) {
    ok
    error
  }
}`

// --- Live-state shapes -----------------------------------------------------------

export interface LiveDnsFilteringProfile {
  id?: string
  name?: string
}

export interface CategoryConfig {
  [flag: string]: boolean | undefined
}

export interface FullDnsFilteringProfile {
  id?: string
  name?: string
  priority?: number
  fallbackMethod?: string
  allowedDomains?: string[]
  deniedDomains?: string[]
  groups?: { edges?: Array<{ node?: NamedRef | null } | null> }
  privacyCategoryConfig?: CategoryConfig
  securityCategoryConfig?: CategoryConfig
  contentCategoryConfig?: CategoryConfig
}

interface MutationEntity {
  id?: string
}

export interface ProfileMutationResult {
  ok?: boolean
  error?: string | null
  entity?: MutationEntity | null
}

export interface CreateMutationResponse {
  dnsFilteringProfileCreate?: ProfileMutationResult
}

export interface UpdateMutationResponse {
  dnsFilteringProfileUpdate?: ProfileMutationResult
}

export interface DeleteMutationResponse {
  dnsFilteringProfileDelete?: { ok?: boolean; error?: string | null }
}

// --- Category config builders --------------------------------------------------

/** Build a full category-config object: every known flag explicit (selected -> true, else false). */
function buildCategoryConfig(allFlags: ReadonlyArray<{ key: string }>, selected: string[]): Record<string, boolean> {
  const selectedSet = new Set(selected)
  const config: Record<string, boolean> = {}
  for (const flag of allFlags) config[flag.key] = selectedSet.has(flag.key)
  return config
}

export function buildContentCategoryConfig(selected: string[]): Record<string, boolean> {
  return buildCategoryConfig(CONTENT_CATEGORY_FLAGS, selected)
}

export function buildSecurityCategoryConfig(selected: string[]): Record<string, boolean> {
  return buildCategoryConfig(SECURITY_CATEGORY_FLAGS, selected)
}

export function buildPrivacyCategoryConfig(selected: string[]): Record<string, boolean> {
  return buildCategoryConfig(PRIVACY_CATEGORY_FLAGS, selected)
}

/** Extract the flags that are `true` on a live category config, sorted for stable comparison. */
export function selectedFlags(config: CategoryConfig | undefined, allFlags: ReadonlyArray<{ key: string }>): string[] {
  if (!config) return []
  return allFlags.filter((f) => config[f.key] === true).map((f) => f.key)
}

// --- Input builders ----------------------------------------------------------

/** The `dnsFilteringProfileUpdate` variables that apply a spec's FULL declared state. */
export function buildUpdateVariables(id: string, spec: DnsFilteringProfileSpec, groupIds: string[]): Record<string, unknown> {
  return {
    id,
    name: spec.name,
    priority: spec.priority,
    allowedDomains: spec.allowedDomains,
    deniedDomains: spec.deniedDomains,
    fallbackMethod: spec.fallbackMethod,
    groups: groupIds,
    privacyCategoryConfig: buildPrivacyCategoryConfig(spec.privacyFlags),
    securityCategoryConfig: buildSecurityCategoryConfig(spec.securityFlags),
    contentCategoryConfig: buildContentCategoryConfig(spec.contentFlags),
  }
}

/** Rebuild `dnsFilteringProfileUpdate` variables that restore a captured prior full state (for rollback). */
export function priorToUpdateVariables(id: string, prior: FullDnsFilteringProfile): Record<string, unknown> {
  const priorGroupIds = (prior.groups?.edges ?? [])
    .map((e) => e?.node?.id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
  return {
    id,
    name: prior.name ?? '',
    priority: prior.priority ?? 1,
    allowedDomains: prior.allowedDomains ?? [],
    deniedDomains: prior.deniedDomains ?? [],
    fallbackMethod: prior.fallbackMethod ?? 'STRICT',
    groups: priorGroupIds,
    privacyCategoryConfig: prior.privacyCategoryConfig ?? buildPrivacyCategoryConfig([]),
    securityCategoryConfig: prior.securityCategoryConfig ?? buildSecurityCategoryConfig([]),
    contentCategoryConfig: prior.contentCategoryConfig ?? buildContentCategoryConfig([]),
  }
}

/** Build a case-insensitive name -> ref lookup from a list of named refs. */
export function byName(refs: NamedRef[]): Map<string, NamedRef> {
  return new Map(refs.filter((r) => r.name && r.id).map((r) => [profileKey(r.name as string), r]))
}

/** Sort + join a set of ids/domains into a stable, comparable string (drift/set comparisons). */
export function setSignature(values: string[]): string {
  return [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))].sort().join(',')
}

/** Throw a descriptive error when a GraphQL call failed at the transport, GraphQL, or ok/error level. */
export function assertMutationOk(
  transportError: string | null,
  errors: { message?: string }[] | null,
  okError: string | null,
  action: string,
): void {
  if (transportError) throw new Error(`Failed to ${action}: ${transportError}`)
  if (errors) throw new Error(`Failed to ${action}: ${errors.map((e) => e.message || 'error').join('; ')}`)
  if (okError) throw new Error(`Failed to ${action}: ${okError}`)
}
