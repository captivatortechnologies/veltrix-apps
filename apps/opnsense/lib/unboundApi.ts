// =============================================================================
// Unbound (DNS Resolver) host-override and domain-forward resources
// (api/unbound/settings/*, api/unbound/service/reconfigure).
//
// Verified: src/opnsense/mvc/app/controllers/OPNsense/Unbound/Api/
// SettingsController.php + src/opnsense/mvc/app/models/OPNsense/Unbound/
// Unbound.xml (mount //OPNsense/unboundplus). No meaningful version floor —
// `hosts.host`/`dots.dot` CRUD via this controller has existed since at
// least mid-2021 (oldest commit touching SettingsController.php: "unbound:
// integrate DoT grid; closes #5101", 2021-07-19).
//
// TERMINOLOGY, verified against source, not assumed: the legacy pfSense/
// OPNsense concept of a "Domain Override" (forward a specific domain's
// queries to a specific DNS server) has NO separate endpoint in the current
// MVC model — it is represented by `dots.dot` with `type: "forward"` (the
// OTHER value being "dot", DNS-over-TLS). SettingsController's own
// `addForwardAction`/`setForwardAction` FORCE `type: "forward"` via an
// addBase/setBase overlay (`["type" => $this->type]`, `$this->type` defaults
// to `'forward'` and is only ever `'dot'` when a caller invokes the
// backwards-compat `...Dot...`-named action, which this app never does) —
// so every record this app's `unbound-domain-overrides` config type creates
// or updates is unconditionally a plain forward, never a DNS-over-TLS entry,
// REGARDLESS of what a live record's type currently is. See the
// unbound-domain-overrides README section for what that implies for a
// record independently configured as DNS-over-TLS via the GUI.
//
// APPLY: `POST /api/unbound/service/reconfigure` — inherited unmodified from
// ApiMutableServiceControllerBase::reconfigureAction() (github.com/opnsense/
// core, src/opnsense/mvc/app/controllers/OPNsense/Base/
// ApiMutableServiceControllerBase.php), which returns the literal
// `{"status":"ok"}` on success. FLAGGED: that base method's default
// `reconfigureForceRestart()` returns `1`, so this call STOPS THEN STARTS
// the Unbound service (not a soft reload) — every deploy/rollback that
// touches a host override or domain override causes a brief DNS resolution
// gap on the box, not just a config regeneration.
// =============================================================================

import { buildModelResource, reconfigureModule, type ModelRecord, type ModelResource, type ModelVerbs, type OpnsenseClient } from './opnsenseCore'

export const UNBOUND_SETTINGS_MODULE = ['unbound', 'settings'] as const
export const UNBOUND_SERVICE_MODULE = ['unbound', 'service'] as const

// --- Host overrides (hosts.host) -----------------------------------------------

const HOST_OVERRIDE_VERBS: ModelVerbs = {
  search: 'searchHostOverride',
  add: 'addHostOverride',
  set: 'setHostOverride',
  del: 'delHostOverride',
}

export interface HostOverrideBody {
  enabled: string
  hostname: string
  domain: string
  rr: string // "A" | "AAAA" | "MX" | "TXT"
  mxprio: string // required (per model SetIfConstraint) when rr = "MX"
  mx: string // required when rr = "MX"
  ttl: string
  server: string // required when rr = "A" | "AAAA" — the IPv4/IPv6 address
  txtdata: string // required when rr = "TXT"
  addptr: string // whether to also create a PTR (reverse-DNS) record
  description: string
}

export interface LiveHostOverride extends ModelRecord {
  enabled?: string
  hostname?: string
  domain?: string
  rr?: string
  mxprio?: string
  mx?: string
  ttl?: string
  server?: string
  txtdata?: string
  addptr?: string
  description?: string
}

function hostOverrideResource(client: OpnsenseClient): ModelResource<LiveHostOverride, HostOverrideBody> {
  return buildModelResource<LiveHostOverride, HostOverrideBody>(client, UNBOUND_SETTINGS_MODULE, 'host', HOST_OVERRIDE_VERBS)
}

/** `GET|POST /api/unbound/settings/searchHostOverride` — `searchBase`-backed, `rowCount: -1` default. */
export function searchHostOverrides(client: OpnsenseClient): Promise<LiveHostOverride[]> {
  return hostOverrideResource(client).search()
}

/** `POST /api/unbound/settings/addHostOverride` — body `{ host: {...} }`. Returns the new uuid. */
export function addHostOverride(client: OpnsenseClient, body: HostOverrideBody): Promise<string> {
  return hostOverrideResource(client).add(body)
}

/** `POST /api/unbound/settings/setHostOverride/<uuid>` — body `{ host: {...} }`. */
export function setHostOverride(client: OpnsenseClient, uuid: string, body: HostOverrideBody): Promise<void> {
  return hostOverrideResource(client).set(uuid, body)
}

/**
 * `POST /api/unbound/settings/delHostOverride/<uuid>`. Verified:
 * `delHostOverrideAction` ALSO deletes every `aliases.alias` (CNAME-style
 * host alias) entry pointing at this host first — this app does not manage
 * that separate `aliases.alias` resource, so a host with hand-created
 * aliases loses them silently when this app deletes the host it points to.
 */
export function deleteHostOverride(client: OpnsenseClient, uuid: string): Promise<void> {
  return hostOverrideResource(client).remove(uuid)
}

// --- Domain (forward) overrides (dots.dot, type=forward) -----------------------

const FORWARD_VERBS: ModelVerbs = { search: 'searchForward', add: 'addForward', set: 'setForward', del: 'delForward' }

export interface DomainOverrideBody {
  enabled: string
  domain: string
  server: string
  port: string
  forward_tcp_upstream: string
  forward_first: string
  description: string
}

export interface LiveDomainOverride extends ModelRecord {
  enabled?: string
  type?: string // always "forward" for records this app manages — see module doc
  domain?: string
  server?: string
  port?: string
  forward_tcp_upstream?: string
  forward_first?: string
  description?: string
}

function domainOverrideResource(client: OpnsenseClient): ModelResource<LiveDomainOverride, DomainOverrideBody> {
  return buildModelResource<LiveDomainOverride, DomainOverrideBody>(client, UNBOUND_SETTINGS_MODULE, 'dot', FORWARD_VERBS)
}

/**
 * `GET|POST /api/unbound/settings/searchForward` — returns BOTH forward AND
 * DNS-over-TLS entries (searchForwardAction has no type filter of its own;
 * only the legacy `...Dot...` catch-all alias narrows by type, which this
 * app never calls) — callers must filter to `type === 'forward'` themselves.
 */
export function searchDomainOverrides(client: OpnsenseClient): Promise<LiveDomainOverride[]> {
  return domainOverrideResource(client).search()
}

/**
 * `POST /api/unbound/settings/addForward` — body `{ dot: {...} }`. The
 * controller overlays `type: "forward"` regardless of what's sent — see
 * module doc. Returns the new uuid.
 */
export function addDomainOverride(client: OpnsenseClient, body: DomainOverrideBody): Promise<string> {
  return domainOverrideResource(client).add(body)
}

/** `POST /api/unbound/settings/setForward/<uuid>` — body `{ dot: {...} }`. Also force-overlays `type: "forward"`. */
export function setDomainOverride(client: OpnsenseClient, uuid: string, body: DomainOverrideBody): Promise<void> {
  return domainOverrideResource(client).set(uuid, body)
}

/** `POST /api/unbound/settings/delForward/<uuid>`. */
export function deleteDomainOverride(client: OpnsenseClient, uuid: string): Promise<void> {
  return domainOverrideResource(client).remove(uuid)
}

// --- Apply (shared by both resources above) ------------------------------------

/**
 * `POST /api/unbound/service/reconfigure` — see the module doc's APPLY
 * paragraph for the full-service-restart flag.
 */
export function reconfigureUnbound(client: OpnsenseClient): Promise<void> {
  return reconfigureModule(client, UNBOUND_SERVICE_MODULE)
}
