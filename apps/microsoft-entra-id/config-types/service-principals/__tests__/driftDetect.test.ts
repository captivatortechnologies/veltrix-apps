// ============================================================================
// driftDetect for Entra service principals, against a fake Microsoft Graph.
//
// The two fields that matter most here are access controls, not cosmetics: an
// `accountEnabled` flipped on brings a disabled enterprise app back to life,
// and an `appRoleAssignmentRequired` turned off opens an app that was limited to
// assigned users to the whole tenant. Both have to surface.
//
// One asymmetry is deliberate and pinned below: Graph returns the UNION of the
// SP's own tags and the backing application's, so tag drift is a subset check —
// a declared tag missing is drift, an extra live tag is not.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const APP_ID = '77777777-7777-4777-8777-777777777777'

const FIND = /\/servicePrincipals\?\$filter=appId/
const SP_MAP = /\/servicePrincipals\?\$select=id,displayName$/
const USERS = /\/users\?\$select=/
const OWNERS = /\/servicePrincipals\/[^/]+\/owners/

function liveSp(over: Record<string, unknown> = {}) {
  return {
    id: 'sp-1',
    appId: APP_ID,
    displayName: 'Contoso Enterprise App',
    accountEnabled: true,
    appRoleAssignmentRequired: false,
    preferredSingleSignOnMode: null,
    homepage: null,
    notificationEmailAddresses: [],
    tags: [],
    servicePrincipalType: 'Application',
    ...over,
  }
}

function spItem(fields: Record<string, unknown> = {}) {
  return item('Contoso Enterprise App', { appId: APP_ID, ...fields })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([spItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed lookup reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: FIND, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([spItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live SP matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: FIND, respond: collection([liveSp({ appRoleAssignmentRequired: true, homepage: 'https://app.contoso.com' })]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(
      driftContext([spItem({ appRoleAssignmentRequired: true, homepage: 'https://app.contoso.com' })]),
    )

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('an uninstalled enterprise app is critical drift', async () => {
  const { restore } = routeFetch([
    { url: FIND, respond: collection([]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([spItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: APP_ID, expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('an app re-enabled and opened to every user in the portal both surface', async () => {
  const { restore } = routeFetch([
    { url: FIND, respond: collection([liveSp({ accountEnabled: true, appRoleAssignmentRequired: false })]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(
      driftContext([spItem({ accountEnabled: false, appRoleAssignmentRequired: true })]),
    )

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: `${APP_ID}.accountEnabled`, expected: 'false', actual: 'true', severity: 'warning' },
      {
        field: `${APP_ID}.appRoleAssignmentRequired`,
        expected: 'true',
        actual: 'false',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a single sign-on mode cleared in the portal reads as "(none)", not an empty diff', async () => {
  const { restore } = routeFetch([
    { url: FIND, respond: collection([liveSp({ preferredSingleSignOnMode: null })]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([spItem({ preferredSingleSignOnMode: 'saml' })]))

    assert.deepEqual(result.diffs, [
      {
        field: `${APP_ID}.preferredSingleSignOnMode`,
        expected: 'saml',
        actual: '(none)',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a declared tag missing from the live SP is drift', async () => {
  const { restore } = routeFetch([
    { url: FIND, respond: collection([liveSp({ tags: ['WindowsAzureActiveDirectoryIntegratedApp'] })]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([spItem({ tags: 'HideApp' })]))

    assert.deepEqual(result.diffs, [
      {
        field: `${APP_ID}.tags`,
        expected: 'HideApp',
        actual: 'WindowsAzureActiveDirectoryIntegratedApp',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('extra live tags alone are not drift — Graph unions them with the application\'s', async () => {
  const { restore } = routeFetch([
    {
      url: FIND,
      respond: collection([liveSp({ tags: ['HideApp', 'WindowsAzureActiveDirectoryIntegratedApp'] })]),
    },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([spItem({ tags: 'HideApp' })]))

    assert.deepEqual(result.diffs, [], 'the declared tag is present; the rest come from the backing app')
  } finally {
    restore()
  }
})

test('a declared owner missing from the live SP is drift', async () => {
  const { restore } = routeFetch([
    { url: FIND, respond: collection([liveSp()]) },
    { url: USERS, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace' }]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, respond: collection([{ id: 'u-someone-else' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([spItem({ owners: 'Ada Lovelace' })]))

    assert.deepEqual(result.diffs, [
      { field: `${APP_ID}.owners`, expected: '["u-1"]', actual: '["u-someone-else"]', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('an extra live owner alone is not drift', async () => {
  const { restore } = routeFetch([
    { url: FIND, respond: collection([liveSp()]) },
    { url: USERS, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace' }]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, respond: collection([{ id: 'u-1' }, { id: 'u-extra' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([spItem({ owners: 'Ada Lovelace' })]))

    assert.deepEqual(result.diffs, [], 'this app never revokes what it did not grant')
  } finally {
    restore()
  }
})

test('an owner name that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: FIND, respond: collection([liveSp()]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([spItem({ owners: 'Ghost Owner' })]))

    assert.deepEqual(result.diffs, [
      {
        field: `${APP_ID}.owners`,
        expected: 'resolvable',
        actual: 'unknown owner(s): Ghost Owner',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})
