// Shared helpers for the Cribl Routes config type.
//
// IMPORTANT — Routes is a SINGLETON per Worker Group, not a collection. Cribl
// stores the entire routing table as ONE ordered object per group:
//
//   { id: "default", routes: [ { name, filter, pipeline, output, final, ... }, ... ], groups? }
//
// Routes are evaluated top-to-bottom, so ORDER is significant. Cribl ships each
// group with exactly one routing table whose id is "default"; there is normally
// no second table to create. This config type therefore models ONE item per
// group whose identity is the fixed routing-table id ("default") and whose
// payload is the ordered `routes` array (table-level extras such as `groups` are
// preserved). Applied over /api/v1[/m/<group>]/routes.
//
// NOTE: the routing-table shape + endpoint follow the documented Cribl REST API
// (single ordered table per group). Verify against a live Cribl.

import { CRIBL_ID_RE, canonicalJson } from '../../lib/criblCommon'

/** The stable id Cribl gives the one routing table in each Worker Group. */
export const ROUTES_TABLE_DEFAULT_ID = 'default'

export { CRIBL_ID_RE, canonicalJson }

/** One Route in the ordered routing table. */
export interface CriblRoute {
  id?: string
  name?: string
  filter?: string
  pipeline?: string
  output?: string
  final?: boolean
  disabled?: boolean
  description?: string
  [key: string]: unknown
}

/** The routing table for a Worker Group — an ordered list of Routes plus extras. */
export interface CriblRoutingTable {
  id?: string
  routes: CriblRoute[]
  groups?: Record<string, unknown>
  [key: string]: unknown
}

export interface ParsedRoutes {
  routes: CriblRoute[] | null
  /** Table-level keys other than id/routes (e.g. `groups`) to preserve on write. */
  extra: Record<string, unknown>
  error: string | null
}

/**
 * Parse the `routes` textarea (JSON) into the ordered Route list. Accepts either
 * a full table object ({ routes: [...] , groups? }) or a bare [ ... ] array of
 * Routes, which is wrapped. Guarantees a `routes` array on success and returns
 * any other table-level keys as `extra`.
 */
export function parseRoutes(raw: unknown): ParsedRoutes {
  const text = String(raw ?? '').trim()
  if (!text) return { routes: null, extra: {}, error: 'routes is empty — provide the routing table as JSON.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { routes: null, extra: {}, error: `routes is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }

  if (Array.isArray(parsed)) {
    return { routes: parsed as CriblRoute[], extra: {}, error: null }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { routes: null, extra: {}, error: 'routes must be a JSON object ({ "routes": [...] }) or a JSON array of routes.' }
  }

  const obj = parsed as Record<string, unknown>
  const routes = obj.routes
  if (!Array.isArray(routes)) {
    return { routes: null, extra: {}, error: 'routes must contain a "routes" array.' }
  }
  const { id: _id, routes: _routes, ...extra } = obj
  return { routes: routes as CriblRoute[], extra, error: null }
}

/** Build the routing-table request body: identity + ordered routes + preserved extras. */
export function buildRoutesBody(id: string, routes: CriblRoute[], extra: Record<string, unknown> = {}): CriblRoutingTable {
  return { ...extra, id: id.trim() || ROUTES_TABLE_DEFAULT_ID, routes }
}
