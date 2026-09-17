// Shared fixtures for the governance-groups handler tests.
//
// A governance group is who approves access, so the live fixture is owned by an
// identity who has since left — exactly the value rollback has to be able to put
// back.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Finance Governance Board'
export const LIVE_ID = 'wg-88c1'

/** What the canvas declares. */
export function groupItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Owns finance access decisions',
    ownerId: 'id-owner-current',
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveGovernanceGroup(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    owner: { id: 'id-owner-departed' },
    ...over,
  }
}

/** A live object matching {@link groupItem} in every field drift tracks. */
export function inSyncGovernanceGroup(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Owns finance access decisions',
    owner: { id: 'id-owner-current' },
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveGovernanceGroup}. */
export const PRIOR = { name: NAME, description: 'Legacy description nobody updated', ownerId: 'id-owner-departed' }
