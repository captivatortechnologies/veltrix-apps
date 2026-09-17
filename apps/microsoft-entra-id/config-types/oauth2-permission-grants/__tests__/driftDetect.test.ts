// ============================================================================
// driftDetect for Entra oauth2 permission grants, against a fake Microsoft Graph.
//
// The drift that matters here is a scope that grew: somebody re-consented in the
// portal and the client can now read mail it was never declared to read. That
// has to surface as a diff, while a scope written in a different ORDER must not
// — the handler normalises the space-delimited scope before comparing, and a
// false positive on ordering would bury the real one.
//
// A grant is also keyed on resolved object ids, so a client name that no longer
// resolves is critical drift rather than a silent "looks fine".
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

const CLIENT = '11111111-1111-4111-8111-111111111111'
const RESOURCE = '22222222-2222-4222-8222-222222222222'
/** The composite natural key the handler builds from the RESOLVED ids. */
const KEY = `${CLIENT}|${RESOURCE}|allprincipals|`

const GRANTS = /\/oauth2PermissionGrants$/
const SP_MAP = /\/servicePrincipals\?\$select=/
const USERS = /\/users\?\$select=/

function liveGrant(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    clientId: CLIENT,
    resourceId: RESOURCE,
    consentType: 'AllPrincipals',
    principalId: null,
    scope: 'User.Read',
    ...over,
  }
}

function grantItem(fields: Record<string, unknown> = {}) {
  return item('Contoso client -> Graph', { clientId: CLIENT, resourceId: RESOURCE, scope: 'User.Read', ...fields })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([grantItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: GRANTS, method: 'GET', respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await driftDetect(driftContext([grantItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live grant matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: GRANTS, method: 'GET', respond: collection([liveGrant()]) },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([grantItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('the same permissions in a different order are not drift', async () => {
  const { restore } = routeFetch([
    { url: GRANTS, method: 'GET', respond: collection([liveGrant({ scope: 'Mail.Read  User.Read' })]) },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([grantItem({ scope: 'User.Read Mail.Read' })]))

    assert.deepEqual(result.diffs, [], 'scope is a set, so ordering and spacing must not register as drift')
  } finally {
    restore()
  }
})

test('a revoked grant is critical drift', async () => {
  const { restore } = routeFetch([
    { url: GRANTS, method: 'GET', respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([grantItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: KEY, expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a scope widened out of band surfaces with the exact permissions added', async () => {
  const { restore } = routeFetch([
    {
      url: GRANTS,
      method: 'GET',
      respond: collection([liveGrant({ scope: 'User.Read Mail.ReadWrite Files.ReadWrite.All' })]),
    },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([grantItem({ scope: 'User.Read' })]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: `${KEY}.scope`,
        expected: 'User.Read',
        actual: 'Files.ReadWrite.All Mail.ReadWrite User.Read',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a single-user grant whose principal is gone from the directory is critical drift', async () => {
  const { restore } = routeFetch([
    { url: GRANTS, method: 'GET', respond: collection([liveGrant({ consentType: 'Principal', principalId: 'u-1' })]) },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(
      driftContext([grantItem({ consentType: 'Principal', principalId: 'Ada Lovelace' })]),
    )

    assert.deepEqual(result.diffs, [
      {
        field: `${CLIENT} -> ${RESOURCE}`,
        expected: 'resolvable',
        actual: 'unknown client/resource/principal reference',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})

test('a hand-typed client name resolves to the same id the live grant is keyed on', async () => {
  // Before the pickers existed a canvas stored display names. Those have to
  // resolve to the object id Graph keys the grant on, or every such grant would
  // spuriously report as absent.
  const { restore } = routeFetch([
    { url: GRANTS, method: 'GET', respond: collection([liveGrant()]) },
    { url: SP_MAP, respond: collection([{ id: CLIENT, displayName: 'Contoso Client' }]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([grantItem({ clientId: 'Contoso Client' })]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})
