// Shared helpers for the Network Device Groups config type (validate + deploy +
// rollback + drift). Field shapes follow the ISE ERS NetworkDeviceGroup
// resource (/ers/config/networkdevicegroup) — verified against the community
// pyise-ers ERS client (github.com/falkowich/pyise-ers, pyiseers/pyiseers.py).

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import { ndgRootFromName, type NetworkDeviceGroup } from '../../lib/iseApi'

export const MAX_NAME_LENGTH = 255
export const MAX_DESCRIPTION_LENGTH = 1000

/** One network device group item, normalized from canvas fields. */
export interface NdgSpec {
  name: string
  description: string
}

/** Read one canvas item's fields into a normalized NDG spec. */
export function specFromItem(item: CanvasItemSnapshot): NdgSpec {
  return {
    name: String(item.fields.name ?? '').trim(),
    description: String(item.fields.description ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): NdgSpec[] {
  return items.map(specFromItem)
}

/**
 * The ERS create/update body for a spec. `othername` (the NDG root category)
 * is ALWAYS derived from `name`'s first "#" segment, mirroring pyise-ers's
 * `add_device_group` — never authored separately, so it can never drift out of
 * sync with the name the operator actually typed.
 */
export function toNetworkDeviceGroupBody(spec: NdgSpec): Omit<NetworkDeviceGroup, 'id' | 'link'> {
  return { name: spec.name, description: spec.description, othername: ndgRootFromName(spec.name) }
}
