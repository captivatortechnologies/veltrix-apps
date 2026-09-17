// Shared fixtures for the source-schemas handler tests.
//
// A source schema is a child of a source, keyed within it by schema name
// (`account`, `group`). `identityAttribute` is the field that decides which
// account attribute correlates to an identity, so the live fixture correlates on
// a different one from the canvas.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const SOURCE_NAME = 'Active Directory'
export const SOURCE_ID = 'src-ad8800b2'
export const SCHEMA_NAME = 'account'
export const SCHEMA_ID = 'sch-2211ee'
export const CHILD_PATH = `/v3/sources/${SOURCE_ID}/schemas`
export const LABEL = `${SOURCE_NAME}/${SCHEMA_NAME}`

/** The parent source as GET /v3/sources returns it. */
export function parentSource(over: Record<string, unknown> = {}) {
  return { id: SOURCE_ID, name: SOURCE_NAME, ...over }
}

export function schemaItem(fields: Record<string, unknown> = {}) {
  return item(SCHEMA_NAME, {
    sourceName: SOURCE_NAME,
    name: SCHEMA_NAME,
    nativeObjectType: 'User',
    identityAttribute: 'sAMAccountName',
    displayAttribute: 'displayName',
    includePermissions: false,
    attributes: [{ name: 'sAMAccountName', type: 'STRING' }],
    configuration: {},
    ...fields,
  })
}

/** What the source currently carries — stale in every tracked field. */
export function liveSchema(over: Record<string, unknown> = {}) {
  return {
    id: SCHEMA_ID,
    name: SCHEMA_NAME,
    nativeObjectType: 'User',
    identityAttribute: 'objectGUID',
    displayAttribute: 'cn',
    includePermissions: true,
    attributes: [{ name: 'objectGUID', type: 'STRING' }],
    configuration: { legacyMode: true },
    ...over,
  }
}

/** A live schema matching {@link schemaItem} in every field drift tracks. */
export function inSyncSchema(over: Record<string, unknown> = {}) {
  return {
    id: SCHEMA_ID,
    name: SCHEMA_NAME,
    nativeObjectType: 'User',
    identityAttribute: 'sAMAccountName',
    displayAttribute: 'displayName',
    ...over,
  }
}

export const PRIOR = {
  name: SCHEMA_NAME,
  nativeObjectType: 'User',
  identityAttribute: 'objectGUID',
  displayAttribute: 'cn',
  includePermissions: true,
  attributes: [{ name: 'objectGUID', type: 'STRING' }],
  configuration: { legacyMode: true },
}
