// Shared helpers for the Security Group Tags config type (validate + deploy +
// rollback + drift). Field shapes and the name-validation rule are verified
// against BOTH the community pyise-ers ERS client (add_sgt —
// github.com/falkowich/pyise-ers) and the official Cisco ISE Ansible
// collection (github.com/CiscoISE/ansible-ise, plugins/modules/sgt.py).

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { Sgt } from '../../lib/iseApi'

export const MAX_NAME_LENGTH = 32
export const MAX_DESCRIPTION_LENGTH = 1000
/** ISE's own SGT naming rule (pyise-ers's `_sgt_name_test`): alnum + underscore only. */
export const SGT_NAME_RE = /^[A-Za-z0-9_]+$/
export const MIN_TAG_VALUE = 2
export const MAX_TAG_VALUE = 65519
/** -1 tells ISE to auto-assign the next available tag value. */
export const AUTO_VALUE = -1

export interface SgtSpec {
  name: string
  description: string
  value: number
  propagateToApic: boolean
}

export function specFromItem(item: CanvasItemSnapshot): SgtSpec {
  const rawValue = item.fields.value
  const value = rawValue === undefined || rawValue === null || rawValue === '' ? AUTO_VALUE : Number(rawValue)
  return {
    name: String(item.fields.name ?? '').trim(),
    description: String(item.fields.description ?? '').trim(),
    value: Number.isFinite(value) ? value : AUTO_VALUE,
    propagateToApic: item.fields.propagate_to_apic === true,
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): SgtSpec[] {
  return items.map(specFromItem)
}

/** [sic] `propogateToApic` keeps ISE's own wire-field typo — see lib/iseApi.ts. */
export function toSgtBody(spec: SgtSpec): Omit<Sgt, 'id' | 'link' | 'isReadOnly'> {
  return { name: spec.name, description: spec.description, value: spec.value, propogateToApic: spec.propagateToApic }
}
