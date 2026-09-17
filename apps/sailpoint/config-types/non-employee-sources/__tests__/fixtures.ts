// Shared fixtures for the non-employee-sources handler tests.
//
// The management workgroup is who administers the non-employee records, so the live
// fixture points at a different workgroup from the canvas.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Contractors'
export const LIVE_ID = 'nes-31aa'

/** What the canvas declares. */
export function sourceItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Contractor records administered by the vendor team',
    ownerId: 'id-owner-current',
    managementWorkgroup: 'wg-vendor-team',
    approvers: ['id-approver-1'],
    accountManagers: ['id-manager-1'],
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveNonEmployeeSource(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    owner: { id: 'id-owner-departed' },
    managementWorkgroup: 'wg-legacy-admins',
    approvers: [{ id: 'id-approver-legacy' }],
    accountManagers: [{ id: 'id-manager-legacy' }],
    ...over,
  }
}

/** A live object matching {@link sourceItem} in every field drift tracks. */
export function inSyncNonEmployeeSource(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Contractor records administered by the vendor team',
    owner: { id: 'id-owner-current' },
    managementWorkgroup: 'wg-vendor-team',
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveNonEmployeeSource}. */
export const PRIOR = {
  name: NAME,
  description: 'Legacy description nobody updated',
  managementWorkgroup: 'wg-legacy-admins',
}
