// =============================================================================
// Static Routes resource (api/routes/routes/*).
//
// Verified: src/opnsense/mvc/app/controllers/OPNsense/Routes/Api/
// RoutesController.php + src/opnsense/mvc/app/models/OPNsense/Routes/
// Route.xml (mount //staticroutes — a top-level ArrayField, NOT nested under
// a named sub-container the way every other resource in this app is). No
// meaningful version floor — this controller predates 2018 (oldest commit:
// "rewrite static routes", 2017-07-30).
//
// VERB CASE — genuinely unusual, verified against the literal PHP method
// names, not assumed: RoutesController's actions are ALL LOWERCASE with NO
// internal capitalization — `searchrouteAction`, `addrouteAction`,
// `setrouteAction`, `delrouteAction` (compare FilterController's
// `searchRuleAction`). Per OPNsense's router (see lib/opnsenseCore.ts's URL
// segment doc), the URL segment must be sent exactly as lowercase
// "searchroute"/"addroute"/etc. — a camelCase "searchRoute" would resolve to
// a DIFFERENT, nonexistent method name and 404.
//
// STAGED DELETE — RoutesController defers the actual OS route removal:
// `setrouteAction`/`delrouteAction` write the route's OLD network value to a
// `/tmp/delete_route_<uuid>.todo` marker file before staging the change, so
// `reconfigureAction` (`interface routes configure`) knows which routes to
// remove from the live routing table even though config.xml itself no longer
// has the old value. This is entirely server-side bookkeeping — this app
// doesn't (and can't) replicate it; addroute/setroute/delroute + one
// reconfigure at the end is the complete, correct client-side sequence.
// =============================================================================

import { buildModelResource, reconfigureModule, type ModelRecord, type ModelResource, type ModelVerbs, type OpnsenseClient } from './opnsenseCore'

export const ROUTES_MODULE = ['routes', 'routes'] as const

const ROUTE_VERBS: ModelVerbs = { search: 'searchroute', add: 'addroute', set: 'setroute', del: 'delroute' }

export interface RouteBody {
  network: string
  /** A gateway NAME from OPNsense's configured gateway list (JsonKeyValueStoreField) — passed through as-is, not enumerable offline. */
  gateway: string
  /** NOTE: the model's own field name is "descr", not "description" — unlike every other resource in this app. */
  descr: string
  enabled: string
}

export interface LiveRoute extends ModelRecord {
  network?: string
  gateway?: string
  descr?: string
  enabled?: string
}

function routeResource(client: OpnsenseClient): ModelResource<LiveRoute, RouteBody> {
  return buildModelResource<LiveRoute, RouteBody>(client, ROUTES_MODULE, 'route', ROUTE_VERBS)
}

/** `GET|POST /api/routes/routes/searchroute` — `searchBase`-backed (sorted by description), `rowCount: -1` default. */
export function searchRoutes(client: OpnsenseClient): Promise<LiveRoute[]> {
  return routeResource(client).search()
}

/** `POST /api/routes/routes/addroute` — body `{ route: {...} }`. Returns the new uuid. */
export function addRoute(client: OpnsenseClient, body: RouteBody): Promise<string> {
  return routeResource(client).add(body)
}

/** `POST /api/routes/routes/setroute/<uuid>` — body `{ route: {...} }`. */
export function setRoute(client: OpnsenseClient, uuid: string, body: RouteBody): Promise<void> {
  return routeResource(client).set(uuid, body)
}

/** `POST /api/routes/routes/delroute/<uuid>`. */
export function deleteRoute(client: OpnsenseClient, uuid: string): Promise<void> {
  return routeResource(client).remove(uuid)
}

/**
 * `POST /api/routes/routes/reconfigure` — verified custom override: runs
 * `interface routes configure` and returns the literal `{"status":"ok"}` on
 * success, `{"status":"error reloading routes (...)"}` otherwise.
 */
export function reconfigureRoutes(client: OpnsenseClient): Promise<void> {
  return reconfigureModule(client, ROUTES_MODULE)
}
