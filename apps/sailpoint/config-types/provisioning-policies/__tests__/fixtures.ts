// Shared fixtures for the provisioning-policies handler tests.
//
// A provisioning policy is a child of a source, keyed within it by `usageType`
// rather than by an id — there is no id anywhere in the rollback entry, so the
// source id plus the usage type IS the address.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const SOURCE_NAME = 'Active Directory'
export const SOURCE_ID = 'src-ad7700c1'
export const USAGE_TYPE = 'CREATE'
export const CHILD_PATH = `/v3/sources/${SOURCE_ID}/provisioning-policies`
export const LABEL = `${SOURCE_NAME}/${USAGE_TYPE}`

/** The parent source as GET /v3/sources returns it. */
export function parentSource(over: Record<string, unknown> = {}) {
  return { id: SOURCE_ID, name: SOURCE_NAME, ...over }
}

export function policyItem(fields: Record<string, unknown> = {}) {
  return item('Create AD Account', {
    sourceName: SOURCE_NAME,
    usageType: USAGE_TYPE,
    name: 'Create AD Account',
    description: 'Attributes written when an AD account is created',
    fields: [{ name: 'sAMAccountName', transform: { type: 'identityAttribute' } }],
    ...fields,
  })
}

/** What the source currently carries — stale in every tracked field. */
export function livePolicy(over: Record<string, unknown> = {}) {
  return {
    name: 'Legacy Create Policy',
    description: 'Legacy description nobody updated',
    usageType: USAGE_TYPE,
    fields: [{ name: 'cn', transform: { type: 'static' } }],
    ...over,
  }
}

/** A live policy matching {@link policyItem} in every field drift tracks. */
export function inSyncPolicy(over: Record<string, unknown> = {}) {
  return {
    name: 'Create AD Account',
    description: 'Attributes written when an AD account is created',
    usageType: USAGE_TYPE,
    ...over,
  }
}

export const PRIOR = {
  name: 'Legacy Create Policy',
  description: 'Legacy description nobody updated',
  usageType: USAGE_TYPE,
  fields: [{ name: 'cn', transform: { type: 'static' } }],
}
