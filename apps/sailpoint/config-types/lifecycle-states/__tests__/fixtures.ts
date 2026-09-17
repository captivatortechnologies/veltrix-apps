// Shared fixtures for the lifecycle-states handler tests.
//
// A lifecycle state is a child of an identity profile, keyed within it by
// `technicalName` rather than by display name. The live state is ENABLED-false
// with a different account-action set, so the prior snapshot is a real record of
// what the tenant was doing to accounts.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const PROFILE_NAME = 'Workday Employees'
export const PROFILE_ID = 'ip-3300de'
export const TECHNICAL_NAME = 'terminated'
export const STATE_ID = 'ls-7712fa'
export const CHILD_PATH = `/v3/identity-profiles/${PROFILE_ID}/lifecycle-states`
export const LABEL = `${PROFILE_NAME}/${TECHNICAL_NAME}`

/** The parent identity profile as GET /v3/identity-profiles returns it. */
export function parentProfile(over: Record<string, unknown> = {}) {
  return { id: PROFILE_ID, name: PROFILE_NAME, ...over }
}

export function stateItem(fields: Record<string, unknown> = {}) {
  return item('Terminated', {
    profileName: PROFILE_NAME,
    name: 'Terminated',
    technicalName: TECHNICAL_NAME,
    description: 'Access removed when someone leaves',
    enabled: true,
    accessProfileIds: ['ap-offboarded'],
    accountActions: [{ action: 'DISABLE', sourceIds: ['src-ad'] }],
    identityState: 'INACTIVE_LONG_TERM_LEAVE',
    ...fields,
  })
}

/** What the profile currently carries — stale in every tracked field. */
export function liveState(over: Record<string, unknown> = {}) {
  return {
    id: STATE_ID,
    name: 'Terminated (legacy)',
    technicalName: TECHNICAL_NAME,
    description: 'Legacy description nobody updated',
    enabled: false,
    accessProfileIds: ['ap-legacy-offboard'],
    accountActions: [{ action: 'ENABLE', sourceIds: ['src-legacy'] }],
    identityState: 'ACTIVE',
    ...over,
  }
}

/** A live state matching {@link stateItem} in every field drift tracks. */
export function inSyncState(over: Record<string, unknown> = {}) {
  return {
    id: STATE_ID,
    name: 'Terminated',
    technicalName: TECHNICAL_NAME,
    description: 'Access removed when someone leaves',
    enabled: true,
    ...over,
  }
}

export const PRIOR = {
  name: 'Terminated (legacy)',
  description: 'Legacy description nobody updated',
  enabled: false,
  accessProfileIds: ['ap-legacy-offboard'],
  accountActions: [{ action: 'ENABLE', sourceIds: ['src-legacy'] }],
  identityState: 'ACTIVE',
}
