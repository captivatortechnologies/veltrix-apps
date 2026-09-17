// Shared fixtures for the password-policies handler tests.
//
// The live policy is deliberately WEAKER than the canvas and carries a read-only
// `lastUpdated` that the rollback snapshot must strip — a snapshot that keeps it
// cannot be PUT back.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Privileged Account Policy'
export const LIVE_ID = 'pp-77e2'

/** What the canvas declares. */
export function policyItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Rules for privileged accounts',
    minLength: 16,
    minSpecial: 1,
    passwordExpiration: 30,
    enablePasswdExpiration: true,
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function livePasswordPolicy(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    defaultPolicy: false,
    minLength: 8,
    minSpecial: 0,
    passwordExpiration: 0,
    enablePasswdExpiration: false,
    sourceIds: ['src-ad'],
    lastUpdated: '2024-01-01T00:00:00Z',
    ...over,
  }
}

/** A live object matching {@link policyItem} in every field drift tracks. */
export function inSyncPasswordPolicy(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Rules for privileged accounts',
    defaultPolicy: false,
    minLength: 16,
    minSpecial: 1,
    passwordExpiration: 30,
    enablePasswdExpiration: true,
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link livePasswordPolicy}. */
export const PRIOR = {
  id: LIVE_ID,
  name: NAME,
  description: 'Legacy description nobody updated',
  defaultPolicy: false,
  minLength: 8,
  minSpecial: 0,
  passwordExpiration: 0,
  enablePasswdExpiration: false,
  sourceIds: ['src-ad'],
}
