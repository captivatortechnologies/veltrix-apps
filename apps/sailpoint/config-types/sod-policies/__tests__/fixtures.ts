// Shared fixtures for the sod-policies handler tests.
//
// `state` is the field that decides whether the policy is actually enforced, so the
// live fixture is NOT_ENFORCED where the canvas asks for ENFORCED.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'AP vs AR Separation'
export const LIVE_ID = 'sod-1188c0'

/** What the canvas declares. */
export function policyItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Accounts payable may not also approve receivables',
    ownerType: 'IDENTITY',
    ownerId: 'id-owner-current',
    state: 'ENFORCED',
    type: 'GENERAL',
    tags: ['finance'],
    policyQuery: 'attribute.department:Finance',
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveSodPolicy(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    ownerRef: { type: 'IDENTITY', id: 'id-owner-departed' },
    state: 'NOT_ENFORCED',
    type: 'GENERAL',
    ...over,
  }
}

/** A live object matching {@link policyItem} in every field drift tracks. */
export function inSyncSodPolicy(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Accounts payable may not also approve receivables',
    ownerRef: { type: 'IDENTITY', id: 'id-owner-current' },
    state: 'ENFORCED',
    type: 'GENERAL',
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveSodPolicy}. */
export const PRIOR = {
  name: NAME,
  description: 'Legacy description nobody updated',
  state: 'NOT_ENFORCED',
  type: 'GENERAL',
  ownerType: 'IDENTITY',
  ownerId: 'id-owner-departed',
}
