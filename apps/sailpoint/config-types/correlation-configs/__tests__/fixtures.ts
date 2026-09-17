// Shared fixtures for the correlation-configs handler tests.
//
// A correlation config decides which account lands on which identity, so the live
// fixture correlates on a different attribute from the canvas.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'HR Account Correlation'
export const LIVE_ID = 'cc-55d0'

/** What the canvas declares. */
export function configItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    attributes: [{ property: 'email', value: 'workEmail' }],
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveCorrelationConfig(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    attributes: [{ property: 'employeeNumber', value: 'legacyEmployeeId' }],
    ...over,
  }
}

/** A live object matching {@link configItem} in every field drift tracks. */
export function inSyncCorrelationConfig(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    attributes: [{ property: 'email', value: 'workEmail' }],
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveCorrelationConfig}. */
export const PRIOR = { name: NAME, attributes: [{ property: 'employeeNumber', value: 'legacyEmployeeId' }] }
