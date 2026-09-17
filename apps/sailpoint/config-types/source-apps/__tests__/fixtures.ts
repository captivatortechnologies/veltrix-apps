// Shared fixtures for the source-apps handler tests.
//
// Source apps are listed from `/beta/source-apps/all` but created and patched at
// `/beta/source-apps` — the contract pins both, because writing to the listing path
// is a mistake nothing else would catch.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Salesforce App'
export const LIVE_ID = 'sa-77aa31'

/** What the canvas declares. */
export function appItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Salesforce accounts in the request centre',
    accountSourceId: 'src-salesforce',
    matchAllAccounts: true,
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveSourceApp(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    accountSource: { id: 'src-salesforce' },
    matchAllAccounts: false,
    ...over,
  }
}

/** A live object matching {@link appItem} in every field drift tracks. */
export function inSyncSourceApp(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Salesforce accounts in the request centre',
    accountSource: { id: 'src-salesforce' },
    matchAllAccounts: true,
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveSourceApp}. */
export const PRIOR = { name: NAME, description: 'Legacy description nobody updated', matchAllAccounts: false }
