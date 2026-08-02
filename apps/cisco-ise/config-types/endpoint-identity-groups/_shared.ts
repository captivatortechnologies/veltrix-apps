// Shared helpers for the Endpoint Identity Groups config type (validate +
// deploy + rollback + drift). Field shapes follow the ISE ERS EndPointGroup
// resource (/ers/config/endpointgroup) — verify against a live ISE node.

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'

export const MAX_NAME_LENGTH = 255
export const MAX_DESCRIPTION_LENGTH = 1000

/** One endpoint identity group item, normalized from canvas fields. */
export interface GroupSpec {
  name: string
  description: string
}

/** Read one canvas item's fields into a normalized group spec. */
export function specFromItem(item: CanvasItemSnapshot): GroupSpec {
  return {
    name: String(item.fields.name ?? '').trim(),
    description: String(item.fields.description ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): GroupSpec[] {
  return items.map(specFromItem)
}
