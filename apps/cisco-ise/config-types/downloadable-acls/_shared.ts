// Shared helpers for the Downloadable ACLs config type (validate + deploy +
// rollback + drift). Field shapes follow the ISE ERS DownloadableAcl resource
// (/ers/config/downloadableacl) — verified against the official Cisco ISE
// Ansible collection (github.com/CiscoISE/ansible-ise,
// plugins/modules/downloadable_acl.py).

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { DownloadableAcl } from '../../lib/iseApi'

export const MAX_NAME_LENGTH = 255
export const MAX_DESCRIPTION_LENGTH = 1000
export const DACL_TYPES = new Set(['IPV4', 'IPV6', 'IP_AGNOSTIC'])
export const DEFAULT_DACL_TYPE = 'IPV4'

export interface DaclSpec {
  name: string
  description: string
  daclType: string
  dacl: string
}

export function normalizeDaclType(value: unknown): string {
  const s = String(value ?? '').trim().toUpperCase()
  return DACL_TYPES.has(s) ? s : DEFAULT_DACL_TYPE
}

export function specFromItem(item: CanvasItemSnapshot): DaclSpec {
  return {
    name: String(item.fields.name ?? '').trim(),
    description: String(item.fields.description ?? '').trim(),
    daclType: normalizeDaclType(item.fields.dacl_type),
    dacl: String(item.fields.dacl ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): DaclSpec[] {
  return items.map(specFromItem)
}

export function toDownloadableAclBody(spec: DaclSpec): Omit<DownloadableAcl, 'id' | 'link'> {
  return { name: spec.name, description: spec.description, daclType: spec.daclType as DownloadableAcl['daclType'], dacl: spec.dacl }
}
