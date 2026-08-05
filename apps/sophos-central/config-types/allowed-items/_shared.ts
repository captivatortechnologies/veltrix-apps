// =============================================================================
// Shared helpers for the Sophos Central Allowed Items config type.
//
// An allowed item is reconciled by its (type, value) pair — Sophos assigns
// the item id on create. The PATCH endpoint only accepts `comment`; any other
// change (type, value, fileName) is delete-then-recreate rather than patched
// in place — see https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/allowed-items/{allowedItemId}/patch.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canonicalJson, str } from '../../lib/sophosCommon'
import type { SophosAllowedItem, SophosAllowedItemProperties } from '../../lib/sophosApi'

export interface AllowedItemSpec {
  itemName: string
  type: string
  value: string
  fileName: string
  comment: string
}

/** The item's logical identity: its (type, value) pair, value lower-cased for matching. */
export function allowedItemKey(type: string, value: string): string {
  return `${type.trim()}::${value.trim().toLowerCase()}`
}

export function extractAllowedItemSpecs(canvas: CanvasSnapshot): AllowedItemSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      type: str(fields.type),
      value: str(fields.value),
      fileName: str(fields.fileName),
      comment: str(fields.comment),
    }
  })
}

/** Map the canvas's single "value" field onto Sophos's per-type properties object. */
export function allowedItemProperties(spec: Pick<AllowedItemSpec, 'type' | 'value' | 'fileName'>): SophosAllowedItemProperties {
  const properties: SophosAllowedItemProperties = {}
  if (spec.type === 'sha256') properties.sha256 = spec.value
  else if (spec.type === 'certificateSigner') properties.certificateSigner = spec.value
  else properties.path = spec.value // 'path' and 'posixPath' both map onto the "path" property
  if (spec.fileName) properties.fileName = spec.fileName
  return properties
}

/** Build the create request body from a declared spec. */
export function buildAllowedItemBody(spec: AllowedItemSpec): Pick<SophosAllowedItem, 'type' | 'properties' | 'comment'> {
  return { type: spec.type, properties: allowedItemProperties(spec), comment: spec.comment }
}

/** The value Sophos actually stored for this item's type — for matching a live item by (type, value). */
export function liveAllowedItemValue(item: SophosAllowedItem): string | undefined {
  if (item.type === 'sha256') return item.properties?.sha256
  if (item.type === 'certificateSigner') return item.properties?.certificateSigner
  return item.properties?.path
}

/** Does the live item's non-comment properties already match the declared spec? */
export function allowedItemPropertiesMatch(spec: AllowedItemSpec, live: SophosAllowedItem): boolean {
  return canonicalJson(allowedItemProperties(spec)) === canonicalJson(live.properties ?? {})
}
