// =============================================================================
// Firewall Category resource (api/firewall/category/*) — split out of the
// original lib/opnsenseApi.ts (now a barrel re-exporting this file).
//
// Verified: src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/CategoryController.php
// + src/opnsense/mvc/app/models/OPNsense/Firewall/Category.xml. Categories are
// pure metadata TAGS referenced by name from aliases, filter rules and NAT
// rules for grouping/color-coding — they have NO live effect on pf, so there
// is no apply/reconfigure step for this resource at all (confirmed: no such
// action exists on CategoryController). This is the oldest resource in this
// app — the model landed in core back in January 2021 (issue #4587), long
// before any OPNsense version this app would plausibly target, so there is
// no meaningful version-floor to flag.
// =============================================================================

import { buildModelResource, type ModelRecord, type ModelResource, type OpnsenseClient } from './opnsenseCore'

export const CATEGORY_MODULE = ['firewall', 'category'] as const

export interface CategoryBody {
  name: string
  color: string // 6 hex digits (e.g. "FF8800"), or "" for none
}

/**
 * `auto` marks a small set of SYSTEM-managed categories (e.g. an "Anti-Lockout"
 * category some Destination NAT versions auto-create) — verified present as a
 * plain BooleanField on the model. This app never creates, edits or deletes a
 * category whose live `auto` is "1", the same way this codebase's Cisco ISE
 * app leaves ISE's system-defined identity groups alone.
 */
export interface LiveCategory extends ModelRecord {
  name?: string
  color?: string
  auto?: string
}

function categoryResource(client: OpnsenseClient): ModelResource<LiveCategory, CategoryBody> {
  return buildModelResource<LiveCategory, CategoryBody>(client, CATEGORY_MODULE, 'category')
}

/** `GET|POST /api/firewall/category/searchItem` — same `rowCount: -1` ("all results") default as aliases. */
export function searchCategories(client: OpnsenseClient): Promise<LiveCategory[]> {
  return categoryResource(client).search()
}

/** `POST /api/firewall/category/addItem` — body `{ category: {...} }`. Returns the new uuid. */
export function addCategory(client: OpnsenseClient, body: CategoryBody): Promise<string> {
  return categoryResource(client).add(body)
}

/** `POST /api/firewall/category/setItem/<uuid>` — body `{ category: {...} }`. */
export function setCategory(client: OpnsenseClient, uuid: string, body: CategoryBody): Promise<void> {
  return categoryResource(client).set(uuid, body)
}

/**
 * `POST /api/firewall/category/delItem/<uuid>`. CategoryController::delItemAction
 * checks `Category::isUsed()` first and throws ("Category in use") if any
 * alias/rule/NAT entry still references it — surfaced as a thrown Error.
 */
export function deleteCategory(client: OpnsenseClient, uuid: string): Promise<void> {
  return categoryResource(client).remove(uuid)
}
