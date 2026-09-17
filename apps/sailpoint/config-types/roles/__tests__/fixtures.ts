// Shared fixtures for the roles handler tests.
//
// A role bundles access profiles, so the live fixture bundles a different set from
// the canvas — that set is what rollback has to be able to put back.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Finance Analyst'
export const LIVE_ID = 'role-2c9180'

/** What the canvas declares. */
export function roleItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Finance reporting access',
    ownerId: 'id-owner-current',
    accessProfileIds: ['ap-finance-read', 'ap-reporting'],
    enabled: true,
    requestable: true,
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveRole(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    owner: { id: 'id-owner-departed' },
    accessProfiles: [{ id: 'ap-finance-legacy' }],
    enabled: false,
    requestable: false,
    ...over,
  }
}

/** A live object matching {@link roleItem} in every field drift tracks. */
export function inSyncRole(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Finance reporting access',
    owner: { id: 'id-owner-current' },
    accessProfiles: [{ id: 'ap-reporting' }, { id: 'ap-finance-read' }],
    enabled: true,
    requestable: true,
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveRole}. */
export const PRIOR = {
  name: NAME,
  description: 'Legacy description nobody updated',
  ownerId: 'id-owner-departed',
  enabled: false,
  requestable: false,
  accessProfileIds: ['ap-finance-legacy'],
}
