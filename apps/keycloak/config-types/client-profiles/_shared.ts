// Shared helpers for the Keycloak Client Profiles config type (deploy + rollback + drift).
//
// Client Profiles are a building block of Keycloak's FAPI-style "client policies"
// framework: a named, ordered set of executors. Unlike every OTHER config type in this
// app, the Admin REST API models the realm's custom profiles as ONE realm-wide
// whole-list resource, not a per-object CRUD collection:
//   GET/PUT /admin/realms/{realm}/client-policies/profiles
//     -> { profiles: ClientProfileRepresentation[], globalProfiles?: ClientProfileRepresentation[] }
// There is no create/update/delete of a single profile — every deploy reads the
// current list once and writes the COMPLETE desired list once. This mirrors
// cisco-meraki's l3-firewall-rules config type (one ordered list per network)
// generalized from "one list per network" to "one list per realm".
//
// Verified directly against the Keycloak server source (keycloak/keycloak on GitHub):
//   - core/.../idm/ClientProfilesRepresentation.java: `profiles` is a `List` field
//     initialized to `new ArrayList<>()` (always present on the wire); `globalProfiles`
//     is a SEPARATE, server-populated field with NO default initializer — Keycloak's
//     own built-in profiles (e.g. the FAPI baseline/advanced profiles), never authored
//     here.
//   - services/.../admin/ClientProfilesResource.java `getProfiles(@QueryParam
//     ("include-global-profiles") boolean)`: `globalProfiles` is populated in the GET
//     response ONLY when that query param is `true`. This config type never sends it,
//     so every GET here comes back with `globalProfiles` absent — nothing to
//     accidentally echo back.
//   - services/.../clientpolicy/ClientPoliciesUtil.java `getValidatedClientProfilesFor
//     Update()` (~line 292) calls `isGlobalProfilesUpdated(proposed, existing)`, which
//     (~line 322) explicitly SKIPS the check "if globalProfiles were not sent" (null or
//     empty) — and even when a `globalProfiles` value equal to the existing set IS sent,
//     the same method unconditionally calls `proposedProfilesRep.setGlobalProfiles(null)`
//     ("Make sure to not save built-in inside realm attribute") before persisting. So the
//     PUT body containing ONLY `{ profiles }` (never `globalProfiles`) is not just a
//     convention here — it is the only shape Keycloak's own server logic ever persists.
//     Sending a non-empty `globalProfiles` that does NOT match the live built-ins is
//     rejected outright with `ClientPolicyException("Global profiles cannot be
//     updated")` (HTTP 400).
//   - ClientPoliciesUtil also rejects (400, server-side) a duplicate custom profile name,
//     a profile name colliding with a global profile name, and an executor whose
//     provider id is not a registered `ClientPolicyExecutorProvider` — this config
//     type's validate.ts checks shape only (name required, no whitespace, executors
//     JSON-array-of-objects); the executor id itself is NOT verified against a live
//     registry (see canvas.yaml helpText for the verified, real provider ids).
//
// `ClientPolicyExecutorRepresentation.java` maps `executor` -> `executorProviderId` and
// `configuration` -> a `JsonNode` via `@JsonProperty`, i.e. `{ executor, configuration? }`
// on the wire — matching the shape this config type authors.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { parseJsonField, readOptionalString, readString } from '../../lib/fields'

/** One entry in a profile's ordered executor list, per ClientPolicyExecutorRepresentation. */
export interface ClientProfileExecutor {
  executor: string
  configuration?: Record<string, unknown>
}

/** A custom client profile, per ClientProfileRepresentation. */
export interface ClientProfileRepresentation {
  name: string
  description?: string
  executors: ClientProfileExecutor[]
}

/**
 * The GET/PUT body shape, per ClientProfilesRepresentation. `globalProfiles` is typed
 * here only so callers can read it defensively on GET — it must NEVER be set when
 * building a PUT body (see the header comment above).
 */
export interface ClientProfilesRepresentation {
  profiles?: ClientProfileRepresentation[]
  globalProfiles?: ClientProfileRepresentation[]
}

export interface ClientProfileSpec {
  itemName: string
  name: string
  description?: string
  executorsRaw: unknown
}

/** Each canvas item declares one custom client profile. */
export function extractClientProfileSpecs(canvas: CanvasSnapshot): ClientProfileSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => ({
    itemName: item.name,
    name: readString(item.fields.name),
    description: readOptionalString(item.fields.description),
    executorsRaw: item.fields.executors,
  }))
}

export interface ParsedExecutors {
  executors: ClientProfileExecutor[] | null
  error: string | null
}

/**
 * Parse the `executors` textarea (JSON) into the ordered executor list: a blank value
 * is a valid "no executors" profile; otherwise it must be a JSON array of objects, each
 * with a non-empty string `executor` and an optional object `configuration`. Shared by
 * validate.ts (shape-check only) and deploy.ts (build the desired representation).
 */
export function parseExecutorsField(raw: unknown): ParsedExecutors {
  const parsed = parseJsonField(raw)
  if (!parsed.ok) return { executors: null, error: 'executors is not valid JSON.' }
  if (parsed.value === undefined) return { executors: [], error: null }
  if (!Array.isArray(parsed.value)) {
    return { executors: null, error: 'executors must be a JSON array of executor objects.' }
  }

  const executors: ClientProfileExecutor[] = []
  for (let i = 0; i < parsed.value.length; i++) {
    const entry = parsed.value[i]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { executors: null, error: `executors[${i}] must be a JSON object.` }
    }
    const rec = entry as Record<string, unknown>
    const executor = typeof rec.executor === 'string' ? rec.executor.trim() : ''
    if (!executor) {
      return { executors: null, error: `executors[${i}] is missing a non-empty "executor" string field.` }
    }
    const configuration = rec.configuration
    if (configuration !== undefined && (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration))) {
      return { executors: null, error: `executors[${i}].configuration must be a JSON object when present.` }
    }
    executors.push(configuration !== undefined ? { executor, configuration: configuration as Record<string, unknown> } : { executor })
  }
  return { executors, error: null }
}

/** Build one profile's representation for the desired PUT list. */
export function buildProfileRep(name: string, description: string | undefined, executors: ClientProfileExecutor[]): ClientProfileRepresentation {
  const rep: ClientProfileRepresentation = { name, executors }
  if (description !== undefined) rep.description = description
  return rep
}

/**
 * Deterministic JSON serialization for drift comparison: object keys are sorted
 * recursively so key-order alone never reports as drift, but ARRAY element order is
 * preserved (executors are an ordered list — reordering them is a real change).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}
