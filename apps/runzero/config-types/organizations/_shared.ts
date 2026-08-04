// Shared helpers for the runZero Organizations config type (deploy + rollback + drift + validate).
//
// A runZero Organization is an account-scoped tenant container — sites, assets and scans all live
// under one. The console API models it as (verified against runZeroInc/runzero-api runzero-api.yml
// — Organization / OrgOptions):
//   List:    GET    /account/orgs           → array of Organization
//   Create:  PUT    /account/orgs           body OrgOptions → Organization
//   Get:     GET    /account/orgs/{id}
//   Update:  PATCH  /account/orgs/{id}      body OrgOptions → Organization
//   Delete:  DELETE /account/orgs/{id}
//
// FLAG (scope): organizations are ACCOUNT-scoped resources — they live under /account, NOT /org. This
// config type requires the connection to carry an ACCOUNT-scoped runZero API key (the same flag as
// scan-templates); an Organization key gets 401/403 here.
//
// FLAG (destructive rollback): a rollback that undoes a CREATE deletes the organization — which
// cascades to every site/asset/scan created under it in the meantime. This mirrors the rollback shape
// already used for sites/scan-templates (delete what was created); it is called out here and in the
// app README because the blast radius is much larger for an organization than for a site.
//
// EXPIRATION FIELDS: OrgOptions carries both legacy per-field retention knobs (expiration_assets_stale/
// expiration_assets_offline/expiration_scans, as decimal-day strings) and a modern `expiration_settings`
// JSON-string blob that replaces three OTHER now-deprecated fields (expiration_integration_attributes,
// expiration_vulnerabilities, keep_latest_integration_attributes — per the spec's own field
// descriptions). This config type exposes the non-deprecated legacy fields plus the modern JSON blob,
// and does not expose the three deprecated fields directly.

/** One runZero Organization as returned by GET /account/orgs (subset of the fields we use). */
export interface RunzeroOrganization {
  id?: string
  name?: string
  description?: string
  parent_id?: string
  expiration_assets_stale?: number
  expiration_assets_offline?: number
  expiration_scans?: number
  expiration_settings?: Record<string, unknown>
  inactive?: boolean
  [key: string]: unknown
}

/** The OrgOptions request body for PUT (create) / PATCH (update). */
export interface RunzeroOrgOptions {
  name: string
  description: string
  parent_id?: string
  expiration_assets_stale?: string
  expiration_assets_offline?: string
  expiration_scans?: string
  expiration_settings?: string
}

/** One entry in deploy's rollbackData.previous — what deploy did to a single organization. */
export interface OrgRollbackEntry {
  name: string
  orgId: string | null
  existed: boolean
  prior: RunzeroOrganization | null
}

/** Trim any value to a string. */
export function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a canvas number field to a non-negative integer day count, or undefined when blank/invalid. */
export function dayCount(value: unknown): number | undefined {
  if (value === '' || value === null || value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined
}

/** Parse the expiration-settings JSON textarea, returning null on blank input or malformed JSON. */
export function parseExpirationSettings(raw: unknown): Record<string, unknown> | null {
  const s = text(raw)
  if (!s) return null
  try {
    const parsed = JSON.parse(s)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** True when two JSON-able values are deeply equal, ignoring key order. */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
}

/** Find a live organization by name (case-insensitive — the stable identity for upsert/drift). */
export function findOrg(orgs: RunzeroOrganization[], name: string): RunzeroOrganization | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return orgs.find((o) => text(o.name).toLowerCase() === n) ?? null
}

/** Build the OrgOptions body from canvas fields. Optional numeric/JSON fields are omitted when blank. */
export function buildOrgOptions(fields: Record<string, unknown>): RunzeroOrgOptions {
  const opts: RunzeroOrgOptions = {
    name: text(fields.name),
    description: text(fields.description),
  }
  const parentId = text(fields.parentId)
  if (parentId) opts.parent_id = parentId

  const stale = dayCount(fields.expirationAssetsStaleDays)
  if (stale !== undefined) opts.expiration_assets_stale = String(stale)

  const offline = dayCount(fields.expirationAssetsOfflineDays)
  if (offline !== undefined) opts.expiration_assets_offline = String(offline)

  const scans = dayCount(fields.expirationScansDays)
  if (scans !== undefined) opts.expiration_scans = String(scans)

  const settingsJson = text(fields.expirationSettingsJson)
  if (settingsJson) opts.expiration_settings = settingsJson

  return opts
}

/** Build an OrgOptions body that restores a prior recorded Organization (rollback). */
export function buildOrgOptionsFromPrior(prior: RunzeroOrganization): RunzeroOrgOptions {
  const opts: RunzeroOrgOptions = {
    name: text(prior.name),
    description: text(prior.description),
  }
  if (prior.parent_id) opts.parent_id = text(prior.parent_id)
  if (prior.expiration_assets_stale !== undefined) opts.expiration_assets_stale = String(prior.expiration_assets_stale)
  if (prior.expiration_assets_offline !== undefined) opts.expiration_assets_offline = String(prior.expiration_assets_offline)
  if (prior.expiration_scans !== undefined) opts.expiration_scans = String(prior.expiration_scans)
  if (prior.expiration_settings && Object.keys(prior.expiration_settings).length > 0) {
    opts.expiration_settings = JSON.stringify(prior.expiration_settings)
  }
  return opts
}
