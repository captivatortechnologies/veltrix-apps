// =============================================================================
// Firewall Alias resource (api/firewall/alias/*) — split out of the original
// lib/opnsenseApi.ts (now a barrel re-exporting this file) for file-size
// reasons once Wave 3 added several more API surfaces.
//
// Verified against OPNsense core's own source (github.com/opnsense/core):
//   controller: src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/AliasController.php
//   model:      src/opnsense/mvc/app/models/OPNsense/Firewall/Alias.xml
//   grid list:  src/opnsense/mvc/app/library/OPNsense/Base/UIModelGrid.php
//
// The model's "stage, then apply" split: addItem/setItem/delItem only write
// the pending configuration (config.xml in memory + on save); NOTHING takes
// effect on the running firewall until reconfigure runs `filter reload
// skip_alias`, `template reload OPNsense/Filter` and `filter refresh_aliases`.
// A deploy/rollback that stages N changes and never calls reconfigure has
// changed nothing a packet actually sees.
// =============================================================================

import { buildModelResource, opnsenseErrorMessage, type ModelRecord, type ModelResource, type OpnsenseClient } from './opnsenseCore'

export const ALIAS_MODULE = ['firewall', 'alias'] as const

/**
 * Every non-container model field is set via BaseField::setValue(), which
 * does a PHP `(string)$value` cast — verified in
 * src/opnsense/mvc/app/models/OPNsense/Base/FieldTypes/BaseField.php. Sending
 * a JSON ARRAY for one of these fields does not "join" it: BaseModel::setNodes
 * explicitly THROWS ("Invalid input type for <field>: expected a single
 * value") the moment it sees `is_array($data[$key])` for a non-container
 * field. So every alias field below — including `content` (see
 * AliasContentField's `private $separatorchar = "\n"`) and the Multiple
 * option field `proto` — must be sent as ONE STRING, never an array. This
 * client only ever builds alias bodies as Record<string, string> to make
 * that mistake structurally impossible. The same rule applies to EVERY other
 * resource in this app (categories, filter rules, source NAT rules, ...).
 */
export interface AliasBody {
  enabled: string // "1" | "0"
  name: string
  type: string
  content: string // entries joined with "\n"
  description: string
  proto: string // "IPv4" | "IPv6" | "IPv4,IPv6" | ""
  interface: string
  updatefreq: string // numeric string, or "" when unset
}

/** A firewall alias exactly as `searchItem` returns it — flat field values (UIModelGrid::fetch). */
export interface LiveAlias extends ModelRecord {
  enabled?: string
  name?: string
  type?: string
  content?: string
  description?: string
  proto?: string
  interface?: string
  updatefreq?: string
}

function aliasResource(client: OpnsenseClient): ModelResource<LiveAlias, AliasBody> {
  return buildModelResource<LiveAlias, AliasBody>(client, ALIAS_MODULE, 'alias')
}

/**
 * List every configured alias. `GET|POST /api/firewall/alias/searchItem`.
 * The server defaults `rowCount` to `-1` ("all results", one page —
 * UIModelGrid::fetchBindRequest/fetch) whenever it is omitted, so a bare call
 * with no query params already returns the complete set: no pagination loop
 * needed, unlike a tool whose list endpoint hard-caps a page size.
 */
export function searchAliases(client: OpnsenseClient): Promise<LiveAlias[]> {
  return aliasResource(client).search()
}

/** `POST /api/firewall/alias/addItem` — body `{ alias: {...} }`. Returns the new uuid. */
export function addAlias(client: OpnsenseClient, body: AliasBody): Promise<string> {
  return aliasResource(client).add(body)
}

/** `POST /api/firewall/alias/setItem/<uuid>` — body `{ alias: {...} }`. */
export function setAlias(client: OpnsenseClient, uuid: string, body: AliasBody): Promise<void> {
  return aliasResource(client).set(uuid, body)
}

/**
 * `POST /api/firewall/alias/delItem/<uuid>`. AliasController::delItemAction
 * checks `whereUsed()` first and throws ("Alias in use") if another alias or
 * a firewall/NAT rule still references this one by name — that failure
 * surfaces here as a thrown Error whose message names the blocker.
 */
export function deleteAlias(client: OpnsenseClient, uuid: string): Promise<void> {
  return aliasResource(client).remove(uuid)
}

/**
 * `POST /api/firewall/alias/reconfigure` — the APPLY step described in the
 * module doc above. Every deploy/rollback that staged at least one
 * add/set/delItem call MUST call this once, after every stage call, before
 * reporting success — otherwise the staged changes sit in the pending
 * configuration and never reach the running pf ruleset. Verified success
 * shape: AliasController::reconfigureAction always returns the literal
 * `{"status":"ok"}` on success (never a passthrough value).
 */
export async function reconfigureAliases(client: OpnsenseClient): Promise<void> {
  const res = await client.request<{ status?: string }>('POST', [...ALIAS_MODULE, 'reconfigure'])
  if (res.data?.status === 'ok') return
  throw new Error(`reconfigure failed — staged alias changes were NOT applied: ${opnsenseErrorMessage(res)}`)
}
