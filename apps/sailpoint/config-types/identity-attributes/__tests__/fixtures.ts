// Shared fixtures for the identity-attributes handler tests.
//
// Identity attributes are keyed by their technical name, not by an id — every path
// is `/beta/identity-attributes/<name>`, and the rollback entry carries no id at
// all. The live fixture is a CUSTOM attribute: standard and system attributes are
// refused outright, which has its own test.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'costCenter'
export const LIVE_ID = 'costCenter'

/** What the canvas declares. */
export function attributeItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    displayName: 'Cost Centre',
    type: 'string',
    multi: false,
    searchable: true,
    sources: [{ type: 'rule', properties: { ruleType: 'IdentityAttribute', ruleName: 'Cost Centre Rule' } }],
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveIdentityAttribute(over: Record<string, unknown> = {}) {
  return {
    name: NAME,
    displayName: 'Cost Centre (legacy)',
    standard: false,
    system: false,
    type: 'string',
    multi: true,
    searchable: false,
    sources: [{ type: 'rule', properties: { ruleName: 'Legacy Cost Centre Rule' } }],
    ...over,
  }
}

/** A live object matching {@link attributeItem} in every field drift tracks. */
export function inSyncIdentityAttribute(over: Record<string, unknown> = {}) {
  return {
    name: NAME,
    displayName: 'Cost Centre',
    standard: false,
    system: false,
    type: 'string',
    multi: false,
    searchable: true,
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveIdentityAttribute}. */
export const PRIOR = {
  name: NAME,
  displayName: 'Cost Centre (legacy)',
  standard: false,
  system: false,
  type: 'string',
  multi: true,
  searchable: false,
  sources: [{ type: 'rule', properties: { ruleName: 'Legacy Cost Centre Rule' } }],
}
