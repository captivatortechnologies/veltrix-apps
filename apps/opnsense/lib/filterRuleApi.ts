// =============================================================================
// Firewall Filter Rule resource (api/firewall/filter/*) — split out of the
// original lib/opnsenseApi.ts (now a barrel re-exporting this file).
//
// *** REQUIRES OPNsense 24.1 "Savvy Shark" (released January 30, 2024) OR
// LATER. *** Verified two independent ways:
//   1. The official changelog (github.com/opnsense/changelog,
//      community/24.1/24.1): "firewall: add automation category for filter
//      rules and source NAT using MVC/API, formerly known as os-firewall
//      plugin" and "plugins: os-firewall moved to core".
//   2. The core commit that introduced these controllers (github.com/
//      opnsense/core, commit 8e299d3e, 2024-01-07, "import net/os-firewall
//      from plugins", https://github.com/opnsense/core/issues/6390) — which
//      added FilterController.php, FilterBaseController.php AND
//      SourceNatController.php in the SAME commit.
// Before 24.1 this functionality existed ONLY as a separately-installed
// "os-firewall" plugin (not guaranteed present, not core) — on an un-upgraded
// pre-24.1 box, every endpoint below returns 404, not a validation error.
//
// Verified: src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/
// FilterController.php + FilterBaseController.php, and the shared model
// src/opnsense/mvc/app/models/OPNsense/Firewall/Filter.xml (mount
// //OPNsense/Firewall/Filter — the SAME model file backs filter rules
// (`rules.rule`), source NAT (`snatrules.rule`), NPTv6 (`npt.rule`) and
// 1:1 NAT (`onetoone.rule`); see sourceNatApi.ts / oneToOneNatApi.ts).
// =============================================================================

import { buildModelResource, RULE_VERBS, type ModelRecord, type ModelResource, type OpnsenseClient } from './opnsenseCore'

export const FILTER_MODULE = ['firewall', 'filter'] as const

/**
 * Ordering — verified against FilterRuleContainerField::getPriority() /
 * FilterRuleField::actionPostLoadingEvent() (src/opnsense/mvc/app/models/
 * OPNsense/Firewall/FieldTypes/FilterRuleField.php), which run on EVERY
 * model load: `prio_group` is a VOLATILE, SERVER-COMPUTED bucket derived
 * purely from `interface` + `interfacenot` (floating: 0 or 2+ interfaces, or
 * interfacenot set; a single OPNsense interface-GROUP; a single ordinary
 * interface; or "invalid" when the named interface doesn't exist) — this app
 * never sends `prio_group` or `sort_order`, only `sequence`. Rules are then
 * sorted `sort_order = "{prio_group}.0{sequence:06d}"`, so `sequence` only
 * orders rules WITHIN the SAME bucket — a floating rule with sequence 1
 * always evaluates before EVERY single-interface rule regardless of that
 * rule's own sequence, because floating's bucket (200000) sorts before a
 * plain interface rule's bucket (400000). This app does not attempt to
 * replicate the UI's drag-and-drop gap-renumbering (moveRuleBefore) — declare
 * well-spaced `sequence` values (e.g. 10, 20, 30) for easy future insertion.
 */
export interface FilterRuleBody {
  enabled: string
  statetype: string
  sequence: string
  action: string
  quick: string
  interfacenot: string
  interface: string // comma-joined (Multiple=Y) — "" = floating (no interface restriction)
  direction: string
  ipprotocol: string
  protocol: string
  source_net: string // comma-joined (Multiple=Y)
  source_not: string
  source_port: string
  destination_net: string // comma-joined (Multiple=Y)
  destination_not: string
  destination_port: string
  log: string
  categories: string // comma-joined category UUIDs
  description: string
}

export interface LiveFilterRule extends ModelRecord {
  enabled?: string
  action?: string
  interface?: string
  interfacenot?: string
  direction?: string
  ipprotocol?: string
  protocol?: string
  source_net?: string
  source_not?: string
  source_port?: string
  destination_net?: string
  destination_not?: string
  destination_port?: string
  log?: string
  categories?: string
  statetype?: string
  sequence?: string
  sort_order?: string
  prio_group?: string
  description?: string
}

function filterRuleResource(client: OpnsenseClient): ModelResource<LiveFilterRule, FilterRuleBody> {
  return buildModelResource<LiveFilterRule, FilterRuleBody>(client, FILTER_MODULE, 'rule', RULE_VERBS)
}

/**
 * `GET|POST /api/firewall/filter/searchRule`. UNLIKE alias/category's
 * `searchItem` (UIModelGrid, `rowCount: -1` = literally unlimited),
 * `searchRule` runs over `ApiControllerBase::searchRecordsetBase()`, whose own
 * default is `rowCount: 9999` (NOT -1) when the param is omitted — verified
 * in ApiControllerBase.php. A bare call therefore returns up to 9999 rules in
 * one page: functionally "everything" for any realistic ruleset, but not
 * literally unbounded the way alias/category search is. Flagged, not faked.
 */
export function searchFilterRules(client: OpnsenseClient): Promise<LiveFilterRule[]> {
  return filterRuleResource(client).search()
}

/** `POST /api/firewall/filter/addRule` — body `{ rule: {...} }`. Returns the new uuid. */
export function addFilterRule(client: OpnsenseClient, body: FilterRuleBody): Promise<string> {
  return filterRuleResource(client).add(body)
}

/** `POST /api/firewall/filter/setRule/<uuid>` — body `{ rule: {...} }`. */
export function setFilterRule(client: OpnsenseClient, uuid: string, body: FilterRuleBody): Promise<void> {
  return filterRuleResource(client).set(uuid, body)
}

/** `POST /api/firewall/filter/delRule/<uuid>`. */
export function deleteFilterRule(client: OpnsenseClient, uuid: string): Promise<void> {
  return filterRuleResource(client).remove(uuid)
}
