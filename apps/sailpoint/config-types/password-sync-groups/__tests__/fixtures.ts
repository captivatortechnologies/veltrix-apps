// Shared fixtures for the password-sync-groups handler tests.
//
// The member source list is the whole point of a sync group, so the live fixture
// covers a different set of sources from the canvas.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Directory Sync Group'
export const LIVE_ID = 'psg-2c10'

/** What the canvas declares. */
export function groupItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    passwordPolicyId: 'pp-standard',
    sourceIds: ['src-ad', 'src-ldap'],
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function livePasswordSyncGroup(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    passwordPolicyId: 'pp-legacy',
    sourceIds: ['src-ad'],
    ...over,
  }
}

/** A live object matching {@link groupItem} in every field drift tracks. */
export function inSyncPasswordSyncGroup(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    passwordPolicyId: 'pp-standard',
    sourceIds: ['src-ldap', 'src-ad'],
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link livePasswordSyncGroup}. */
export const PRIOR = { name: NAME, passwordPolicyId: 'pp-legacy', sourceIds: ['src-ad'] }
