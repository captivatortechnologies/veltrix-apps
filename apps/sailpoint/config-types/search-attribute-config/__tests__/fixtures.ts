// Shared fixtures for the search-attribute-config handler tests.
//
// Extended search attributes are keyed by name, so the rollback entry carries no
// id. `applicationAttributes` maps sourceId to the account attribute it reads, and
// the live fixture maps a different source from the canvas.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'newMailAttribute'
export const LIVE_ID = 'newMailAttribute'

/** What the canvas declares. */
export function attributeItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    displayName: 'Alternate Mail',
    applicationAttributes: { 'src-ad': 'mail' },
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveSearchAttribute(over: Record<string, unknown> = {}) {
  return {
    name: NAME,
    displayName: 'Alternate Mail (legacy)',
    applicationAttributes: { 'src-legacy': 'otherMailbox' },
    ...over,
  }
}

/** A live object matching {@link attributeItem} in every field drift tracks. */
export function inSyncSearchAttribute(over: Record<string, unknown> = {}) {
  return {
    name: NAME,
    displayName: 'Alternate Mail',
    applicationAttributes: { 'src-ad': 'mail' },
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveSearchAttribute}. */
export const PRIOR = { displayName: 'Alternate Mail (legacy)', applicationAttributes: { 'src-legacy': 'otherMailbox' } }
