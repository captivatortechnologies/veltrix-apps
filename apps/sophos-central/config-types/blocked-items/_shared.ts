// =============================================================================
// Shared helpers for the Sophos Central Blocked Items config type.
//
// Blocked items are reconciled by SHA256 (Sophos assigns the item id on
// create) — there is no PATCH endpoint, so an existing item whose fileName /
// path / comment differ from the declared spec is deleted and recreated
// rather than patched in place.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { str } from '../../lib/sophosCommon'
import type { SophosBlockedItem } from '../../lib/sophosApi'

export interface BlockedItemSpec {
  itemName: string
  sha256: string
  fileName: string
  path: string
  comment: string
}

/** The item's logical identity: its SHA256, lower-cased for matching. */
export function blockedItemKey(sha256: string): string {
  return sha256.trim().toLowerCase()
}

export function extractBlockedItemSpecs(canvas: CanvasSnapshot): BlockedItemSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      sha256: str(fields.sha256),
      fileName: str(fields.fileName),
      path: str(fields.path),
      comment: str(fields.comment),
    }
  })
}

/** Build the create request body from a declared spec. */
export function buildBlockedItemBody(spec: BlockedItemSpec): { properties: SophosBlockedItem['properties']; comment: string } {
  const properties: SophosBlockedItem['properties'] = { sha256: spec.sha256 }
  if (spec.fileName) properties.fileName = spec.fileName
  if (spec.path) properties.path = spec.path
  return { properties, comment: spec.comment }
}

/** Does the live item already match the declared spec (fileName/path/comment)? */
export function blockedItemMatches(spec: BlockedItemSpec, live: SophosBlockedItem): boolean {
  return (live.properties?.fileName ?? '') === spec.fileName && (live.properties?.path ?? '') === spec.path && (live.comment ?? '') === spec.comment
}
