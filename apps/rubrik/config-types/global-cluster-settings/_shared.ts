// Shared helpers for the Rubrik Global Cluster Settings config type (deploy +
// rollback + drift).
//
// Bundles the cluster-identity and network settings that are genuinely
// declarative and carry no secret material, each verified against the Rubrik
// Python SDK (rubrikinc/rubrik-sdk-for-python, rubrik_cdm/cluster.py) and the
// PowerShell SDK's Set-RubrikSetting API data:
//   name/timezone/geolocation: GET/PATCH /api/v1/cluster/me
//     (configure_cluster_location, configure_timezone; Set-RubrikSetting)
//   DNS nameservers:           GET/POST /api/internal/cluster/me/dns_nameserver   (bare string[], full replace)
//   DNS search domains:        GET/POST /api/internal/cluster/me/dns_search_domain (bare string[], full replace)
//   NTP servers:                GET/POST /api/internal/cluster/me/ntp_server       (CDM 5+: [{server}], full replace)
//   Login banner:               GET/PUT  /api/internal/cluster/me/login_banner     ({ loginBanner })
//
// This is a cluster SINGLETON: one canvas item represents the whole cluster's
// settings. A canvas targeting more than one rubrik-cluster component applies
// the SAME declared values to every one of them — use a separate canvas per
// cluster if names/timezones/DNS must differ.
//
// FLAG (verify against a live Rubrik CDM cluster): the exact PATCH acceptance of
// a partial body against /api/v1/cluster/me (this app always sends the full
// declared subset), and whether the target CDM version still wraps NTP servers
// as { data: [{ server }] } (CDM 5.0+, per the Python SDK's version check) rather
// than a bare string[] (pre-5.0) — this app reads/writes the 5.0+ shape and
// defensively accepts a bare array on GET too.

/**
 * Timezones Rubrik CDM accepts for cluster configuration — the curated enum
 * from the Rubrik Python SDK's configure_timezone() valid_timezones list, not
 * the full IANA tz database.
 */
export const RUBRIK_TIMEZONES = [
  'America/Anchorage',
  'America/Araguaina',
  'America/Barbados',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Noronha',
  'America/Phoenix',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Bangkok',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Magadan',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Atlantic/Cape_Verde',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Athens',
  'Europe/London',
  'Europe/Moscow',
  'Pacific/Auckland',
  'Pacific/Honolulu',
  'Pacific/Midway',
  'UTC',
] as const
export type RubrikTimezone = (typeof RUBRIK_TIMEZONES)[number]

/** The declarative shape this config type manages, independent of wire format. */
export interface ClusterSettingsSpec {
  clusterName: string
  timezone: string
  location: string
  dnsServers: string[]
  dnsSearchDomains: string[]
  ntpServers: string[]
  loginBanner: string
}

/** Shape of GET /api/v1/cluster/me (only the fields this config type manages). */
export interface RubrikClusterInfo {
  id?: string
  name?: string
  timezone?: { timezone?: string }
  geolocation?: { address?: string }
  [key: string]: unknown
}

/** Trim + normalize a value. */
export function normalizeText(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a canvas timezone field to a known enum value (defaults to UTC). */
export function normalizeTimezone(value: unknown): RubrikTimezone {
  const s = normalizeText(value)
  return (RUBRIK_TIMEZONES as readonly string[]).includes(s) ? (s as RubrikTimezone) : 'UTC'
}

/**
 * Coerce a canvas field to a clean string[]. Accepts a native array (the `tags`
 * field type) OR a comma/newline-separated string, preserving order while
 * dropping blanks and duplicates.
 */
export function toStringArray(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => String(v ?? ''))
    : String(value ?? '').split(/[\r\n,]+/)
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const s = item.trim()
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/** Build the declarative spec from the flat canvas fields. */
export function buildClusterSettingsSpec(fields: Record<string, unknown>): ClusterSettingsSpec {
  return {
    clusterName: normalizeText(fields.clusterName),
    timezone: normalizeTimezone(fields.timezone),
    location: normalizeText(fields.location),
    dnsServers: toStringArray(fields.dnsServers),
    dnsSearchDomains: toStringArray(fields.dnsSearchDomains),
    ntpServers: toStringArray(fields.ntpServers),
    loginBanner: normalizeText(fields.loginBanner),
  }
}

/** Build the PATCH /api/v1/cluster/me body — only name/timezone/geolocation, only when set. */
export function buildClusterInfoPatch(spec: Pick<ClusterSettingsSpec, 'clusterName' | 'timezone' | 'location'>): Record<string, unknown> {
  const body: Record<string, unknown> = { timezone: { timezone: spec.timezone } }
  if (spec.clusterName) body.name = spec.clusterName
  body.geolocation = { address: spec.location }
  return body
}

/** Unwrap a list endpoint's response into a flat string[] — bare array or { data }-wrapped. */
export function stringListFrom(resp: unknown): string[] {
  if (Array.isArray(resp)) return resp.map((v) => String(v))
  if (resp && typeof resp === 'object' && Array.isArray((resp as { data?: unknown }).data)) {
    return (resp as { data: unknown[] }).data.map((v) => String(v))
  }
  return []
}

/**
 * Unwrap the NTP servers list — CDM 5.0+ wraps each server as { server }; older
 * CDM returned bare strings. Accept either shape defensively.
 */
export function ntpServersFrom(resp: unknown): string[] {
  const list = Array.isArray(resp) ? resp : (resp && typeof resp === 'object' ? (resp as { data?: unknown[] }).data : undefined)
  if (!Array.isArray(list)) return []
  return list.map((entry) => (entry && typeof entry === 'object' ? String((entry as { server?: unknown }).server ?? '') : String(entry))).filter(Boolean)
}

/** Build the CDM 5.0+ NTP servers POST body — an array of { server } objects. */
export function buildNtpServersBody(servers: string[]): Array<{ server: string }> {
  return servers.map((server) => ({ server }))
}

/** Shape of GET/PUT /api/internal/cluster/me/login_banner. */
export interface LoginBannerResponse {
  loginBanner?: string
  [key: string]: unknown
}

/** True when two string lists contain the same members, ignoring order. */
export function stringListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}
