// Shared fixtures for the sources handler tests.
//
// `deleteThreshold` is the safety valve that stops a bad aggregation deleting every
// account, so the live fixture has none where the canvas sets one.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Active Directory'
export const LIVE_ID = 'src-ad2200'

/** What the canvas declares. */
export function sourceItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Corporate AD forest',
    ownerId: 'id-owner-current',
    connectorName: 'active-directory-direct',
    clusterId: 'mc-onprem',
    connectorAttributes: { forest: 'corp.example.test' },
    deleteThreshold: 10,
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveSource(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    owner: { id: 'id-owner-departed' },
    connectorName: 'active-directory-direct',
    cluster: { id: 'mc-onprem' },
    deleteThreshold: 0,
    ...over,
  }
}

/** A live object matching {@link sourceItem} in every field drift tracks. */
export function inSyncSource(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Corporate AD forest',
    owner: { id: 'id-owner-current' },
    connectorName: 'active-directory-direct',
    deleteThreshold: 10,
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveSource}. */
export const PRIOR = {
  name: NAME,
  description: 'Legacy description nobody updated',
  ownerId: 'id-owner-departed',
  deleteThreshold: 0,
}
