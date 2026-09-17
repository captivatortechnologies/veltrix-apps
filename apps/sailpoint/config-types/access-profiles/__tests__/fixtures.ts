// Shared fixtures for the access-profiles handler tests.
//
// The canvas item and the live object are deliberately different in every field
// the handler tracks except `source` — the source is immutable, and a live
// profile on a different source makes deploy refuse rather than update, which is
// its own test. Keeping the two apart everywhere else is what makes "records the
// LIVE prior, not the desired values" a real assertion.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Finance DB Read-Write'
export const SOURCE_ID = 'src-finance-db'
export const LIVE_ID = 'ap-2c918085'

export function profileItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Read/write access to the finance database',
    ownerId: 'id-owner-current',
    sourceId: SOURCE_ID,
    entitlementIds: ['ent-db-read', 'ent-db-write'],
    enabled: true,
    requestable: true,
    ...fields,
  })
}

/** What the tenant currently has — same source, everything else stale. */
export function liveProfile(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    owner: { id: 'id-owner-departed' },
    source: { id: SOURCE_ID },
    entitlements: [{ id: 'ent-db-read-only' }],
    enabled: false,
    requestable: false,
    ...over,
  }
}

/** A live profile that matches {@link profileItem} in every tracked field. */
export function inSyncProfile(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Read/write access to the finance database',
    owner: { id: 'id-owner-current' },
    source: { id: SOURCE_ID },
    entitlements: [{ id: 'ent-db-write' }, { id: 'ent-db-read' }],
    enabled: true,
    requestable: true,
    ...over,
  }
}

export const PRIOR = {
  name: NAME,
  description: 'Legacy description nobody updated',
  ownerId: 'id-owner-departed',
  enabled: false,
  requestable: false,
  entitlementIds: ['ent-db-read-only'],
}
