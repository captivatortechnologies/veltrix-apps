// Shared fixtures for the transforms handler tests.
//
// The live transform reads a different input attribute from the canvas, so the
// prior snapshot is genuinely the tenant’s mapping rather than a copy of the
// desired one.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Upper Case Email'
export const LIVE_ID = 'tf-5f9022'

/** What the canvas declares. */
export function transformItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    type: 'upper',
    attributes: { input: { type: 'accountAttribute', attributes: { sourceName: 'AD', attributeName: 'mail' } } },
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveTransform(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    type: 'upper',
    internal: false,
    attributes: { input: { type: 'identityAttribute', attributes: { name: 'legacyEmail' } } },
    ...over,
  }
}

/** A live object matching {@link transformItem} in every field drift tracks. */
export function inSyncTransform(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    type: 'upper',
    attributes: { input: { type: 'accountAttribute', attributes: { sourceName: 'AD', attributeName: 'mail' } } },
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveTransform}. */
export const PRIOR = {
  name: NAME,
  type: 'upper',
  attributes: { input: { type: 'identityAttribute', attributes: { name: 'legacyEmail' } } },
}
