// Shared fixtures for the service-desk-integrations handler tests.
//
// The provider `attributes` object is secret-bearing and ISC masks it on read, so
// the rollback snapshot deliberately carries only the scalars — the prior fixture
// reflects exactly that, not a wishful full copy.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'ServiceNow Tickets'
export const LIVE_ID = 'sdi-4b20f1'

/** What the canvas declares. */
export function integrationItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Raise provisioning tickets in ServiceNow',
    type: 'ServiceNowSDIM',
    ownerId: 'id-owner-current',
    clusterId: 'mc-onprem',
    attributes: { apiUrl: 'https://acme.service-now.example' },
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveServiceDesk(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    type: 'ServiceNowSDIM',
    ownerRef: { id: 'id-owner-departed' },
    clusterRef: { id: 'mc-onprem' },
    ...over,
  }
}

/** A live object matching {@link integrationItem} in every field drift tracks. */
export function inSyncServiceDesk(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Raise provisioning tickets in ServiceNow',
    type: 'ServiceNowSDIM',
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveServiceDesk}. */
export const PRIOR = { name: NAME, description: 'Legacy description nobody updated' }
