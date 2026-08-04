// Shared helpers for the Keycloak Client Policies config type (deploy + rollback + drift).
//
// A Client Policy is a named condition set that applies one or more Client Profiles
// (see the sibling client-profiles config type) to matching clients — the other half
// of Keycloak's FAPI-style "client policies" framework. Like client-profiles,
// `client-policies/policies` is a realm-wide WHOLE-LIST singleton, not a per-object
// CRUD collection:
//   GET/PUT /admin/realms/{realm}/client-policies/policies
//     -> { policies: ClientPolicyRepresentation[], globalPolicies?: ClientPolicyRepresentation[] }
// Every deploy reads the current list once and writes the COMPLETE desired list once —
// the same "one list per realm" shape as client-profiles (itself generalized from
// cisco-meraki's l3-firewall-rules "one list per network").
//
// Verified directly against the Keycloak server source (keycloak/keycloak on GitHub):
//   - core/.../idm/ClientPoliciesRepresentation.java: `policies` is a `List` field
//     initialized to `new ArrayList<>()` (always present on the wire); `globalPolicies`
//     is a SEPARATE, server-populated field with NO default initializer — Keycloak's
//     own built-in policies, never authored here.
//   - services/.../admin/ClientPoliciesResource.java `getPolicies(@QueryParam
//     ("include-global-policies") boolean)`: `globalPolicies` is populated in the GET
//     response ONLY when that query param is `true`. This config type never sends it.
//   - services/.../clientpolicy/ClientPoliciesUtil.java `getValidatedClientPoliciesFor
//     Update()` (~line 577) calls `isGlobalPoliciesUpdated(proposed, existing)`
//     (~line 328), which explicitly SKIPS the check "if globalPolicies were not sent"
//     (null or empty) — so the PUT body containing ONLY `{ policies }` (never
//     `globalPolicies`) is the safe, and in fact the only sanctioned, shape. Sending a
//     non-empty `globalPolicies` that does NOT equal the live built-ins is rejected
//     outright with `ClientPolicyException("Global policies cannot be updated")`
//     (HTTP 400).
//   - The same method's `validatePolicies()` helper (~line 505) rebuilds every policy
//     from scratch from only `{ name, description, enabled, mode, conditions,
//     profiles }` on EVERY update (not just ours) — Keycloak's own PUT handler is a
//     genuine full replace, never a per-item merge with the prior live object. It also
//     rejects (400, server-side): a duplicate custom policy name, a name colliding
//     with a global policy, a `profiles` entry that does not resolve to a real custom
//     OR global profile name, duplicate `profiles` entries within one policy, and a
//     `conditions[].condition` id that is not a registered `ClientPolicyConditionProvider`.
//     This config type's validate.ts checks shape only (see canvas.yaml helpText for
//     the verified, real condition provider ids) — it cannot verify a referenced
//     profile name without live target access, so an unresolvable `profiles` entry
//     surfaces as a deploy-time API error rather than a validate-time one.
//   - `ClientPolicyRepresentation.java` also declares a `mode` field (a
//     `ClientPolicyMode` enum — e.g. `STRICT` — controlling how an ABSTAIN condition
//     vote is handled). This config type deliberately does NOT author `mode`: the
//     canvas schema is scoped to `{ name, description, enabled, conditions, profiles }`
//     only. Because Keycloak's update path always rebuilds every policy from scratch
//     (see above), any policy previously given a non-default `mode` via the Admin
//     Console (or elsewhere) will have that `mode` reset to unset the next time this
//     config type deploys — flagged here since it is easy to miss.
//   - `ClientPolicyRepresentation.enabled` is a `Boolean` object (nullable), not a
//     primitive. `validatePolicies()` (~line 524) resolves a null/absent `enabled` to
//     `Boolean.FALSE`, and `getEnabledClientPolicies()` (~line 412) treats null the
//     same as `false` — an absent `enabled` means DISABLED, not enabled. This config
//     type always sends an explicit boolean, and drift comparison treats a live
//     `enabled` of anything other than literal `true` as `false` to match.
//
// `ClientPolicyConditionRepresentation.java` maps `condition` -> `conditionProviderId`
// and `configuration` -> a `JsonNode` via `@JsonProperty`, i.e. `{ condition,
// configuration? }` on the wire — matching the shape this config type authors.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { parseJsonField, readBool, readOptionalString, readString, readStringArray } from '../../lib/fields'

/** One entry in a policy's condition set, per ClientPolicyConditionRepresentation. */
export interface ClientPolicyCondition {
  condition: string
  configuration?: Record<string, unknown>
}

/** A custom client policy, per ClientPolicyRepresentation (the `mode` field is not authored here — see header). */
export interface ClientPolicyRepresentation {
  name: string
  description?: string
  enabled: boolean
  conditions: ClientPolicyCondition[]
  profiles: string[]
}

/**
 * The GET/PUT body shape, per ClientPoliciesRepresentation. `globalPolicies` is typed
 * here only so callers can read it defensively on GET — it must NEVER be set when
 * building a PUT body (see the header comment above).
 */
export interface ClientPoliciesRepresentation {
  policies?: ClientPolicyRepresentation[]
  globalPolicies?: ClientPolicyRepresentation[]
}

export interface ClientPolicySpec {
  itemName: string
  name: string
  description?: string
  enabled: boolean
  conditionsRaw: unknown
  profiles: string[]
}

/** Each canvas item declares one custom client policy. */
export function extractClientPolicySpecs(canvas: CanvasSnapshot): ClientPolicySpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => ({
    itemName: item.name,
    name: readString(item.fields.name),
    description: readOptionalString(item.fields.description),
    enabled: readBool(item.fields.enabled, true),
    conditionsRaw: item.fields.conditions,
    profiles: readStringArray(item.fields.profiles),
  }))
}

export interface ParsedConditions {
  conditions: ClientPolicyCondition[] | null
  error: string | null
}

/**
 * Parse the `conditions` textarea (JSON) into the condition set: a blank value is a
 * valid "no conditions" policy (it will never match — see canvas.yaml); otherwise it
 * must be a JSON array of objects, each with a non-empty string `condition` and an
 * optional object `configuration`. Shared by validate.ts (shape-check only) and
 * deploy.ts (build the desired representation).
 */
export function parseConditionsField(raw: unknown): ParsedConditions {
  const parsed = parseJsonField(raw)
  if (!parsed.ok) return { conditions: null, error: 'conditions is not valid JSON.' }
  if (parsed.value === undefined) return { conditions: [], error: null }
  if (!Array.isArray(parsed.value)) {
    return { conditions: null, error: 'conditions must be a JSON array of condition objects.' }
  }

  const conditions: ClientPolicyCondition[] = []
  for (let i = 0; i < parsed.value.length; i++) {
    const entry = parsed.value[i]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { conditions: null, error: `conditions[${i}] must be a JSON object.` }
    }
    const rec = entry as Record<string, unknown>
    const condition = typeof rec.condition === 'string' ? rec.condition.trim() : ''
    if (!condition) {
      return { conditions: null, error: `conditions[${i}] is missing a non-empty "condition" string field.` }
    }
    const configuration = rec.configuration
    if (configuration !== undefined && (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration))) {
      return { conditions: null, error: `conditions[${i}].configuration must be a JSON object when present.` }
    }
    conditions.push(configuration !== undefined ? { condition, configuration: configuration as Record<string, unknown> } : { condition })
  }
  return { conditions, error: null }
}

/** Build one policy's representation for the desired PUT list. */
export function buildPolicyRep(
  name: string,
  description: string | undefined,
  enabled: boolean,
  conditions: ClientPolicyCondition[],
  profiles: string[],
): ClientPolicyRepresentation {
  const rep: ClientPolicyRepresentation = { name, enabled, conditions, profiles }
  if (description !== undefined) rep.description = description
  return rep
}

/**
 * Keycloak treats a missing/null `enabled` as disabled (see header) — normalize a live
 * representation's `enabled` the same way so drift comparison never sees a false
 * mismatch against our always-explicit boolean.
 */
export function liveEnabled(rep: Pick<ClientPolicyRepresentation, 'enabled'>): boolean {
  return rep.enabled === true
}

/**
 * Deterministic JSON serialization for drift comparison: object keys are sorted
 * recursively so key-order alone never reports as drift, but ARRAY element order is
 * preserved (conditions are an ordered list).
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
