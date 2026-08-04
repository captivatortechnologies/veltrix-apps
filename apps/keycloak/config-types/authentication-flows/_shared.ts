// Shared helpers for the Keycloak Authentication Flows config type (deploy +
// rollback + drift).
//
// Authentication flows follow the Keycloak Admin REST API
// AuthenticationFlowRepresentation (/admin/realms/{realm}/authentication/flows).
// There is no direct get-by-alias endpoint — GET .../flows returns every flow in
// the realm, so upsert matches by exact `alias` client-side (same list+match shape
// as the groups config type's findGroupByName). The flow's internal `id` (not its
// alias) is the {id} path segment for PUT/DELETE.
//
// SAFETY: this config type must never modify or delete a live flow whose
// `builtIn === true` — Keycloak's own built-in flows (browser, direct grant,
// registration, reset credentials, clients, docker auth, first broker login, …)
// are never authored here. An item whose alias matches a live built-in flow fails
// loudly (see builtInRefusalMessage) instead of silently rewriting it.
//
// SCOPE: this config type manages ONLY the flow CONTAINER (alias, description,
// provider type). It does NOT author the execution/step graph inside a flow (which
// authenticators run, in what order, under what requirement/priority, or nested
// subflows) — that is Keycloak's .../authentication/flows/{flowAlias}/executions
// ordered-graph API, a materially different and riskier surface (creation-order
// dependent pre-Keycloak-25, priority-based on 25+, nested subflows). A flow
// created here is an empty, immediately-usable container an operator finishes
// wiring up in Keycloak's own flow designer. This mirrors the same boundary the
// sibling `authentik` Veltrix app draws around its own Flows config type, which
// also does not author FlowStageBinding.
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Authentication Management" resource).

import { readOptionalString, readString } from '../../lib/fields'

/** The only providerId values this config type accepts (a closed set — see canvas.yaml). */
export const FLOW_PROVIDER_IDS = new Set(['basic-flow', 'client-flow'])

export const DEFAULT_PROVIDER_ID = 'basic-flow'

/** A Keycloak authentication flow as returned by GET /admin/realms/{realm}/authentication/flows. */
export interface KeycloakAuthFlowRep {
  /** Internal UUID — the {id} path segment for PUT/DELETE .../flows/{id}; never the alias. */
  id?: string
  /** The flow alias — this config type's identity. May contain spaces. */
  alias?: string
  description?: string
  /** basic-flow (user authentication) or client-flow (client/service-account). Immutable after creation. */
  providerId?: string
  topLevel?: boolean
  /** True for a Keycloak-shipped flow. This config type refuses to touch these. */
  builtIn?: boolean
  [key: string]: unknown
}

/** Find a flow by its exact alias (the stable identity) in a full flow listing. */
export function findFlowByAlias(flows: KeycloakAuthFlowRep[], alias: string): KeycloakAuthFlowRep | null {
  const target = alias.trim()
  if (!target) return null
  return flows.find((f) => String(f.alias ?? '').trim() === target) ?? null
}

/** The error this config type raises whenever it refuses to touch a live built-in flow. */
export function builtInRefusalMessage(alias: string): string {
  return `refusing to modify built-in flow "${alias}" — author a new custom flow with a different alias instead`
}

/**
 * Build the AuthenticationFlowRepresentation body from canvas fields.
 *
 * Create (no `base`): always forced to `topLevel: true, builtIn: false` regardless
 * of any input — a custom top-level flow is the only safe thing this config type
 * authors.
 *
 * Update (`base` = the existing live flow — caller must have already verified it is
 * not builtIn): the live rep is spread as the base and only `alias`/`description`
 * are overridden; `providerId` is treated as immutable after creation and is left
 * untouched.
 */
export function buildAuthFlowRep(fields: Record<string, unknown>, base?: KeycloakAuthFlowRep): KeycloakAuthFlowRep {
  const alias = readString(fields.alias)

  if (base) {
    const rep: KeycloakAuthFlowRep = { ...base, alias }
    const description = readOptionalString(fields.description)
    if (description !== undefined) rep.description = description
    else if ('description' in base) rep.description = base.description
    return rep
  }

  const rep: KeycloakAuthFlowRep = {
    alias,
    providerId: readString(fields.providerId) || DEFAULT_PROVIDER_ID,
    topLevel: true,
    builtIn: false,
  }
  const description = readOptionalString(fields.description)
  if (description !== undefined) rep.description = description
  return rep
}

/** The field this config type declares, projected for drift comparison. */
export interface AuthFlowProjection {
  description: string
}

export function projectFromFields(fields: Record<string, unknown>): AuthFlowProjection {
  return { description: readString(fields.description) }
}

export function projectFromLive(flow: KeycloakAuthFlowRep): AuthFlowProjection {
  return { description: readString(flow.description) }
}
