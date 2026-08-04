// Shared helpers for the User Identity Groups config type (validate + deploy +
// rollback + drift). Field shapes verified against the official Cisco ISE
// Ansible collection (github.com/CiscoISE/ansible-ise,
// plugins/modules/identitygroup.py): name, description, parent, and that
// create (POST, no pre-existing id) is supported.
//
// UNVERIFIED: the single-resource wrapper key "IdentityGroup" — see
// lib/iseApi.ts's module doc for why this one field, alone among this app's
// wrapper keys, could not be directly confirmed from a real request/response
// example.

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { IdentityGroup } from '../../lib/iseApi'

export const MAX_NAME_LENGTH = 255
export const MAX_DESCRIPTION_LENGTH = 1000

export interface IdentityGroupSpec {
  name: string
  description: string
  /** Another identity group's NAME — resolved to an id at deploy/drift time. */
  parentName: string
}

export function specFromItem(item: CanvasItemSnapshot): IdentityGroupSpec {
  return {
    name: String(item.fields.name ?? '').trim(),
    description: String(item.fields.description ?? '').trim(),
    parentName: String(item.fields.parent ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): IdentityGroupSpec[] {
  return items.map(specFromItem)
}

/** `parentId` is the resolved id for `spec.parentName` — omitted when there is no parent. */
export function toIdentityGroupBody(spec: IdentityGroupSpec, parentId: string | null): Omit<IdentityGroup, 'id' | 'link'> {
  const body: Omit<IdentityGroup, 'id' | 'link'> = { name: spec.name, description: spec.description }
  if (parentId) body.parent = parentId
  return body
}
