// =============================================================================
// Firewall 1:1 NAT resource (api/firewall/one_to_one/*).
//
// *** REQUIRES OPNsense 24.1.9 OR LATER (released June 18, 2024). *** More
// precise than firewall-filter/source-nat's 24.1 floor: the `onetoone.rule`
// node has existed in the shared Filter.xml model since the original 24.1
// "os-firewall" import (2024-01-07), but its OWN API controller
// (OneToOneController.php) was not added until later — verified via its git
// history (github.com/opnsense/core, oldest commit `cd81bcc9`, 2024-04-25,
// "Firewall: NAT: One-to-One - refactor to MVC, closes opnsense/core#7250")
// and pinned to an exact release via the official changelog
// (github.com/opnsense/changelog, community/24.1/24.1.9, dated June 18,
// 2024): "This is the last bit of preparation for the upcoming 24.7 series
// reimplementing one-to-one NAT using MVC/API". Before 24.1.9, this endpoint
// does not exist (404), even on a box already running 24.1+ for
// firewall-rules/source-nat.
//
// Verified: src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/
// OneToOneController.php (extends FilterBaseController, action names match
// RULE_VERBS exactly: searchRuleAction/addRuleAction/setRuleAction/
// delRuleAction) and the `onetoone.rule` node in Filter.xml (see
// filterRuleApi.ts's module doc for the shared-model citation).
//
// IDENTITY: like firewall-rules/source-nat, `onetoone.rule` has NO name
// field — this app reconciles by the canvas item's own stable id (see
// config-types/one-to-one-nat/_shared.ts).
// =============================================================================

import { applyFilterModule, buildModelResource, RULE_VERBS, type ModelRecord, type ModelResource, type OpnsenseClient } from './opnsenseCore'

export const ONE_TO_ONE_MODULE = ['firewall', 'one_to_one'] as const

export interface OneToOneRuleBody {
  enabled: string
  log: string
  sequence: string
  interface: string // single value, default "wan"
  type: string // "binat" | "nat"
  source_net: string
  source_not: string
  destination_net: string
  destination_not: string
  external: string // the external (translated-to) address/network
  natreflection: string // "" (default) | "enable" | "disable"
  categories: string // comma-joined category UUIDs
  description: string
}

export interface LiveOneToOneRule extends ModelRecord {
  enabled?: string
  log?: string
  sequence?: string
  interface?: string
  type?: string
  source_net?: string
  source_not?: string
  destination_net?: string
  destination_not?: string
  external?: string
  natreflection?: string
  categories?: string
  description?: string
}

function oneToOneRuleResource(client: OpnsenseClient): ModelResource<LiveOneToOneRule, OneToOneRuleBody> {
  return buildModelResource<LiveOneToOneRule, OneToOneRuleBody>(client, ONE_TO_ONE_MODULE, 'rule', RULE_VERBS)
}

/** `GET|POST /api/firewall/one_to_one/searchRule` — `searchBase`-backed (UIModelGrid), `rowCount: -1` ("all results") default. */
export function searchOneToOneRules(client: OpnsenseClient): Promise<LiveOneToOneRule[]> {
  return oneToOneRuleResource(client).search()
}

/** `POST /api/firewall/one_to_one/addRule` — body `{ rule: {...} }`. Returns the new uuid. */
export function addOneToOneRule(client: OpnsenseClient, body: OneToOneRuleBody): Promise<string> {
  return oneToOneRuleResource(client).add(body)
}

/** `POST /api/firewall/one_to_one/setRule/<uuid>` — body `{ rule: {...} }`. */
export function setOneToOneRule(client: OpnsenseClient, uuid: string, body: OneToOneRuleBody): Promise<void> {
  return oneToOneRuleResource(client).set(uuid, body)
}

/** `POST /api/firewall/one_to_one/delRule/<uuid>`. */
export function deleteOneToOneRule(client: OpnsenseClient, uuid: string): Promise<void> {
  return oneToOneRuleResource(client).remove(uuid)
}

/**
 * `POST /api/firewall/one_to_one/apply` — inherited unmodified from
 * FilterBaseController::applyAction() (the SAME lenient, non-"ok"-pinned
 * contract as firewall-rules/source-nat's apply — see
 * lib/opnsenseCore.ts's applyFilterModule doc). Runs the same
 * `filter reload skip_alias` full pf reload.
 */
export function applyOneToOneNat(client: OpnsenseClient): Promise<string> {
  return applyFilterModule(client, ONE_TO_ONE_MODULE)
}
