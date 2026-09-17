// Shared fixtures for the segments handler tests.
//
// A segment scopes who can see what, and `active` is the switch that turns that
// scoping on. The live fixture is inactive where the canvas asks for active.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'EMEA Segment'
export const LIVE_ID = 'seg-9a0155'

/** What the canvas declares. */
export function segmentItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Access visible to EMEA staff',
    active: true,
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveSegment(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    active: false,
    ...over,
  }
}

/** A live object matching {@link segmentItem} in every field drift tracks. */
export function inSyncSegment(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Access visible to EMEA staff',
    active: true,
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveSegment}. */
export const PRIOR = { name: NAME, description: 'Legacy description nobody updated', active: false }
