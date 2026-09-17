// Shared fixtures for the identity-profiles handler tests.
//
// Priority decides which profile wins when an identity matches more than one, so
// the live fixture sits at a different priority from the canvas.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Workday Employees'
export const LIVE_ID = 'ip-44f0'

/** What the canvas declares. */
export function profileItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Employees sourced from Workday',
    ownerId: 'id-owner-current',
    priority: 10,
    authoritativeSourceId: 'src-workday',
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveIdentityProfile(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    owner: { id: 'id-owner-departed' },
    priority: 90,
    authoritativeSource: { id: 'src-workday' },
    ...over,
  }
}

/** A live object matching {@link profileItem} in every field drift tracks. */
export function inSyncIdentityProfile(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Employees sourced from Workday',
    owner: { id: 'id-owner-current' },
    priority: 10,
    authoritativeSource: { id: 'src-workday' },
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveIdentityProfile}. */
export const PRIOR = {
  name: NAME,
  description: 'Legacy description nobody updated',
  ownerId: 'id-owner-departed',
  priority: 90,
}
