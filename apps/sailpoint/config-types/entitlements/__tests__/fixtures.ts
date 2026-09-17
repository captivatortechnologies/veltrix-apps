// Shared fixtures for the entitlements handler tests.
//
// This config type never creates or deletes an entitlement — entitlements arrive
// through source aggregation. It only overlays governance metadata onto one that
// already exists, matched inside a source by name (optionally disambiguated by
// schema attribute). The live entitlement is deliberately un-governed: not
// requestable, not privileged, owned by someone who has left, with no aggregation
// locks — which is precisely the state rollback has to be able to return to.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const SOURCE_NAME = 'Active Directory'
export const SOURCE_ID = 'src-ad5500a3'
export const NAME = 'Finance-RW'
export const ATTRIBUTE = 'memberOf'
export const ENTITLEMENT_ID = 'ent-88fa20cd'
export const ENTITLEMENTS = '/beta/entitlements'
export const LABEL = `${SOURCE_NAME}/${NAME}`

/** The parent source as GET /v3/sources returns it. */
export function parentSource(over: Record<string, unknown> = {}) {
  return { id: SOURCE_ID, name: SOURCE_NAME, ...over }
}

export function entitlementItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    sourceName: SOURCE_NAME,
    attribute: ATTRIBUTE,
    name: NAME,
    description: 'Read/write on the finance share',
    ownerId: 'id-owner-current',
    requestable: true,
    privileged: true,
    segments: ['seg-emea'],
    lockDisplayName: true,
    lockDescription: true,
    ...fields,
  })
}

/** The discovered entitlement before any governance overlay. */
export function liveEntitlement(over: Record<string, unknown> = {}) {
  return {
    id: ENTITLEMENT_ID,
    name: NAME,
    attribute: ATTRIBUTE,
    value: 'CN=Finance-RW,OU=Groups',
    description: 'Legacy description nobody updated',
    requestable: false,
    privileged: false,
    owner: { id: 'id-owner-departed' },
    segments: ['seg-legacy'],
    manuallyUpdatedFields: { DISPLAY_NAME: false, DESCRIPTION: false },
    source: { id: SOURCE_ID, name: SOURCE_NAME },
    ...over,
  }
}

/** An entitlement carrying exactly the overlay {@link entitlementItem} declares. */
export function inSyncEntitlement(over: Record<string, unknown> = {}) {
  return {
    id: ENTITLEMENT_ID,
    name: NAME,
    attribute: ATTRIBUTE,
    description: 'Read/write on the finance share',
    requestable: true,
    privileged: true,
    owner: { id: 'id-owner-current' },
    segments: ['seg-emea'],
    manuallyUpdatedFields: { DISPLAY_NAME: true, DESCRIPTION: true },
    source: { id: SOURCE_ID, name: SOURCE_NAME },
    ...over,
  }
}

export const PRIOR = {
  name: NAME,
  description: 'Legacy description nobody updated',
  requestable: false,
  privileged: false,
  ownerId: 'id-owner-departed',
  segments: ['seg-legacy'],
  lockDisplayName: false,
  lockDescription: false,
}
