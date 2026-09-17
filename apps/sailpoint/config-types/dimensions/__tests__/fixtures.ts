// Shared fixtures for the dimensions handler tests.
//
// A dimension is a child of a role, resolved parent-first: the role is looked up
// by name to get the id the child path is built from. The live dimension bundles
// a different set of access profiles and entitlements from the canvas, so the
// prior snapshot is genuinely what the tenant had.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const ROLE_NAME = 'Finance Analyst'
export const ROLE_ID = 'role-9001aa'
export const NAME = 'EMEA Dimension'
export const DIMENSION_ID = 'dim-4410bc'
export const CHILD_PATH = `/beta/roles/${ROLE_ID}/dimensions`
export const LABEL = `${ROLE_NAME}/${NAME}`

/** The parent role as GET /v3/roles returns it. */
export function parentRole(over: Record<string, unknown> = {}) {
  return { id: ROLE_ID, name: ROLE_NAME, ...over }
}

export function dimensionItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    roleName: ROLE_NAME,
    name: NAME,
    description: 'EMEA scope of the finance role',
    ownerType: 'IDENTITY',
    ownerId: 'id-owner-current',
    accessProfileIds: ['ap-emea-finance'],
    entitlementIds: ['ent-emea-ledger'],
    ...fields,
  })
}

/** What the role currently carries — stale in every tracked field. */
export function liveDimension(over: Record<string, unknown> = {}) {
  return {
    id: DIMENSION_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    owner: { id: 'id-owner-departed', type: 'IDENTITY' },
    accessProfiles: [{ id: 'ap-legacy-finance' }],
    entitlements: [{ id: 'ent-legacy-ledger' }],
    ...over,
  }
}

/** A live dimension matching {@link dimensionItem} in every field drift tracks. */
export function inSyncDimension(over: Record<string, unknown> = {}) {
  return {
    id: DIMENSION_ID,
    name: NAME,
    description: 'EMEA scope of the finance role',
    owner: { id: 'id-owner-current', type: 'IDENTITY' },
    ...over,
  }
}

export const PRIOR = {
  name: NAME,
  description: 'Legacy description nobody updated',
  ownerType: 'IDENTITY',
  ownerId: 'id-owner-departed',
  accessProfileIds: ['ap-legacy-finance'],
  entitlementIds: ['ent-legacy-ledger'],
}
