// Shared fixtures for the sim-integrations handler tests.
//
// The managed-resource list is what the integration actually covers, so the live
// fixture covers a different set from the canvas. Secret attributes are masked on
// read and so are absent from the live fixture and from the prior snapshot.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'ServiceNow SIM'
export const LIVE_ID = 'sim-6d3390'

/** What the canvas declares. */
export function integrationItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Service desk routing for managed resources',
    type: 'ServiceNow Service Desk',
    cluster: 'mc-onprem',
    sources: ['src-ad', 'src-ldap'],
    attributes: { apiUrl: 'https://acme.service-now.example' },
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveSimIntegration(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    type: 'ServiceNow Service Desk',
    cluster: 'mc-onprem',
    sources: ['src-legacy'],
    ...over,
  }
}

/** A live object matching {@link integrationItem} in every field drift tracks. */
export function inSyncSimIntegration(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Service desk routing for managed resources',
    type: 'ServiceNow Service Desk',
    sources: ['src-ldap', 'src-ad'],
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveSimIntegration}. */
export const PRIOR = { name: NAME, description: 'Legacy description nobody updated', sources: ['src-legacy'] }
