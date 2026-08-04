// =============================================================================
// Firewall Source NAT (outbound NAT) resource (api/firewall/source_nat/*) —
// split out of the original lib/opnsenseApi.ts (now a barrel re-exporting
// this file).
//
// *** Same OPNsense 24.1+ requirement as firewall-filter (see filterRuleApi.ts) ***
// — SourceNatController.php was added in the SAME commit (8e299d3e) as
// FilterController.php/FilterBaseController.php. Verified:
// src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/SourceNatController.php
// (`snatrules.rule` in the SAME shared Filter.xml model as filter rules).
//
// Outbound NAT MODE gate — verified in Filter.xml's `general.snat_mode`
// (OptionValues: automatic / hybrid / advanced / disabled, default
// "automatic") and SourceNatController::searchRuleAction()'s own mode switch:
// manual `snatrules.rule` entries are only ever evaluated by pf when the mode
// is "hybrid" or "advanced" ("manual"). In "automatic" (the OPNsense DEFAULT)
// or "disabled" mode, this app's rules stage into config.xml and `apply`
// happily reloads the ruleset, but the rules have ZERO effect — OPNsense
// generates its own automatic outbound rules instead. This app does not
// change `snat_mode` itself (a global setting outside this config type's
// scope) — see `getSourceNatMode` below, surfaced as a healthCheck warning.
// =============================================================================

import { buildModelResource, RULE_VERBS, type ModelRecord, type ModelResource, type OpnsenseClient } from './opnsenseCore'

export const SOURCE_NAT_MODULE = ['firewall', 'source_nat'] as const

export interface SourceNatRuleBody {
  enabled: string
  nonat: string
  sequence: string
  interface: string // single value (no Multiple flag on this model's interface field)
  ipprotocol: string
  protocol: string
  source_net: string // single value
  source_not: string
  source_port: string
  destination_net: string // single value
  destination_not: string
  destination_port: string
  target: string // blank = the interface's own address
  target_port: string
  staticnatport: string
  log: string
  categories: string // comma-joined category UUIDs
  'endpoint-independent': string
  description: string
}

export interface LiveSourceNatRule extends ModelRecord {
  enabled?: string
  nonat?: string
  interface?: string
  ipprotocol?: string
  protocol?: string
  source_net?: string
  source_not?: string
  source_port?: string
  destination_net?: string
  destination_not?: string
  destination_port?: string
  target?: string
  target_port?: string
  staticnatport?: string
  log?: string
  categories?: string
  sequence?: string
  description?: string
  /** True for OPNsense's own synthetic automatic-mode rows (never returned for manual rules this app owns). */
  is_automatic?: boolean
}

function sourceNatRuleResource(client: OpnsenseClient): ModelResource<LiveSourceNatRule, SourceNatRuleBody> {
  return buildModelResource<LiveSourceNatRule, SourceNatRuleBody>(client, SOURCE_NAT_MODULE, 'rule', RULE_VERBS)
}

/** `GET|POST /api/firewall/source_nat/searchRule` — same `rowCount: 9999` default caveat as filter rules. */
export function searchSourceNatRules(client: OpnsenseClient): Promise<LiveSourceNatRule[]> {
  return sourceNatRuleResource(client).search()
}

/** `POST /api/firewall/source_nat/addRule` — body `{ rule: {...} }`. Returns the new uuid. */
export function addSourceNatRule(client: OpnsenseClient, body: SourceNatRuleBody): Promise<string> {
  return sourceNatRuleResource(client).add(body)
}

/** `POST /api/firewall/source_nat/setRule/<uuid>` — body `{ rule: {...} }`. */
export function setSourceNatRule(client: OpnsenseClient, uuid: string, body: SourceNatRuleBody): Promise<void> {
  return sourceNatRuleResource(client).set(uuid, body)
}

/** `POST /api/firewall/source_nat/delRule/<uuid>`. */
export function deleteSourceNatRule(client: OpnsenseClient, uuid: string): Promise<void> {
  return sourceNatRuleResource(client).remove(uuid)
}

/**
 * The current outbound-NAT mode (`general.snat_mode` on the shared Filter
 * model — see the module doc above). BEST-EFFORT: `GET
 * /api/firewall/source_nat/get` (SourceNatController::getAction, inherited
 * from ApiMutableModelControllerBase::getAction/getModelNodes) returns OPTION
 * fields in their full FORM representation — `{ optionKey: { selected: "1"|1,
 * ... }, ... }` — the same shape this app already relies on for Alias
 * `content` in firewall-aliases. That shape is well-established for OPTION
 * fields generally, but has not been exercised against a live box for THIS
 * specific field, so a parse miss degrades to `null` (callers skip the mode
 * warning) instead of throwing.
 */
export async function getSourceNatMode(client: OpnsenseClient): Promise<string | null> {
  const res = await client.request<{ filter?: { general?: { snat_mode?: unknown } } }>('GET', [...SOURCE_NAT_MODULE, 'get'])
  const raw = res.data?.filter?.general?.snat_mode
  if (typeof raw === 'string') return raw || null
  if (raw && typeof raw === 'object') {
    for (const [key, opt] of Object.entries(raw as Record<string, unknown>)) {
      const selected = (opt as { selected?: unknown } | null)?.selected
      if (selected === 1 || selected === '1' || selected === true) return key
    }
  }
  return null
}
