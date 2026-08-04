// Shared helpers for the Cortex XDR Prevention Profiles config type (deploy +
// rollback + drift).
//
// CONFIRMED public write path (re-verified 2026-08 against the "Cortex Platform"
// docs, Endpoint Management tag) — the agent security POLICY surface: a
// prevention profile is a named bundle of protection-module configuration
// assigned to endpoints. Round-trippable by combining TWO endpoint families:
//   read:   POST /public_api/v1/endpoints/get_profiles/   (type: "prevention")
//   add:    POST /public_api/v1/profiles/prevention/add/
//   edit:   POST /public_api/v1/profiles/prevention/edit/
//
// IMPORTANT — unlike every other write endpoint in this app, add/edit here send
// their body DIRECTLY (no `{ request_data: ... }` RPC envelope); only the READ
// (get_profiles) uses the standard envelope. VERIFIED against the raw OpenAPI
// fragment for these two paths (2026-08) — use client.post() (raw), not
// client.call() (which always wraps in request_data), for add/edit.
//
// There is NO documented delete endpoint for prevention profiles — like Hash
// Exceptions, this type is add + edit but not delete: rollback can restore an
// updated profile's prior body, but a profile this deploy CREATED cannot be
// auto-removed (reported for manual removal). Default profiles (is_default)
// also cannot be edited per Cortex's own docs — deploy surfaces that as a clear
// error rather than silently failing.
//
// A profile is identified by a caller-chosen NAME + a server-assigned numeric
// id — this type reconciles by name: list -> match -> edit by id, or add.
//
// VERIFY every endpoint path, the exact `profile_type` / `platform` value sets
// (Cortex's own docs describe them only as untyped strings) and the
// module-specific `modules` shape (via /profiles/prevention/get_modules/, not
// modeled here) against a live Cortex XDR tenant.

// --- Cortex XDR prevention-profile endpoints (VERIFY against live Cortex XDR) --
// All are POST under /public_api/v1. The client prepends the base + /public_api/v1.
export const PREVENTION_PROFILE_ENDPOINTS = {
  /** REAL read, uses the { request_data } envelope. Body: { request_data: { type: "prevention", profile_ids? } }. */
  get: '/endpoints/get_profiles/',
  /** RAW body — NOT wrapped in request_data. Body: { name, profile_type, platform, description?, modules }. */
  add: '/profiles/prevention/add/',
  /** RAW body — NOT wrapped in request_data. Body: { profile_id, update_data: { name?, description?, modules? } }. */
  edit: '/profiles/prevention/edit/',
} as const

/** One prevention profile as read back from get_profiles (type: prevention). */
export interface LivePreventionProfile {
  id?: number
  uuid?: string
  name?: string
  type?: string
  is_default?: boolean
  is_global?: boolean
  is_disabled?: boolean
  description?: string
  modules?: Record<string, unknown>
  [key: string]: unknown
}

/** The add/edit request bodies. */
export interface PreventionProfileAddBody {
  name: string
  profile_type: string
  platform: string
  description?: string
  modules: Record<string, unknown>
}
export interface PreventionProfileEditBody {
  profile_id: number
  update_data: { name?: string; description?: string; modules?: Record<string, unknown> }
}

/** Trim + lowercase a name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** get_profiles wraps its payload as { reply: [...] }. VERIFY. */
export function profilesFromReply(reply: unknown): LivePreventionProfile[] {
  if (Array.isArray(reply)) return reply as LivePreventionProfile[]
  if (reply && typeof reply === 'object') {
    const inner = (reply as Record<string, unknown>).profiles
    if (Array.isArray(inner)) return inner as LivePreventionProfile[]
  }
  return []
}

/** Find a live profile by its (normalized) name. */
export function findProfile(profiles: LivePreventionProfile[], name: string): LivePreventionProfile | null {
  const target = normalizeName(name)
  if (!target) return null
  return profiles.find((p) => normalizeName(p.name) === target) ?? null
}

/** Parse the required modules JSON blob. Throws on invalid JSON or a blank value. */
export function parseModulesJson(value: unknown): Record<string, unknown> {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('modules is required')
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('modules must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** True when the modules JSON blob is non-blank and parses as a JSON object. */
export function isValidModulesJson(value: unknown): boolean {
  try {
    parseModulesJson(value)
    return true
  } catch {
    return false
  }
}

/** Build the add body from canvas fields. Throws when modules is missing/invalid JSON. */
export function buildAddBody(fields: Record<string, unknown>): PreventionProfileAddBody {
  const body: PreventionProfileAddBody = {
    name: String(fields.name ?? '').trim(),
    profile_type: String(fields.profile_type ?? '').trim(),
    platform: String(fields.platform ?? '').trim(),
    modules: parseModulesJson(fields.modules),
  }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  return body
}

/** Build the edit body from canvas fields + the live profile id. */
export function buildEditBody(profileId: number, fields: Record<string, unknown>): PreventionProfileEditBody {
  return {
    profile_id: profileId,
    update_data: {
      name: String(fields.name ?? '').trim(),
      description: String(fields.description ?? '').trim(),
      modules: parseModulesJson(fields.modules),
    },
  }
}
