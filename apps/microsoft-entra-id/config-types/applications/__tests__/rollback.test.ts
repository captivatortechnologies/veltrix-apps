// ============================================================================
// rollback for Entra application registrations, against a fake Microsoft Graph.
//
// Two rules carry the whole handler. The first is provenance: a registration
// this deploy CREATED is deleted, one it merely updated is restored to the live
// values captured at deploy time — never deleted, because deleting a tenant's
// pre-existing app registration breaks every sign-in that uses it. The second
// is that an owner reference is revoked only when this deploy added it, and the
// revoke addresses `/owners/{id}/$ref`; drop the `/$ref` and Graph deletes the
// owner's own directory object instead of the ownership.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  graphError,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  rollbackContext,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

/** The managed-field snapshot deploy records for an app it updated. */
const PRIOR = {
  displayName: 'Contoso API',
  signInAudience: 'AzureADMultipleOrgs',
  web: { redirectUris: ['https://old.contoso.com/callback'] },
  spa: { redirectUris: [] },
  identifierUris: ['api://contoso'],
  tags: ['HideApp'],
  groupMembershipClaims: null,
  appRoles: [],
  requiredResourceAccess: [],
}

function updated(over: Record<string, unknown> = {}) {
  return { name: 'Contoso API', uniqueName: 'Contoso-API', existed: true, id: 'app-1', prior: PRIOR, ...over }
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }, { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior fields captured at deploy, not the canvas values', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith('/applications/app-1'))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a registration the deploy created, without chasing its owners', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: 'New API',
            uniqueName: 'New-API',
            existed: false,
            id: 'app-new',
            owners: [{ id: 'u-1', existed: false }],
          },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'deleting the app takes its owner references with it')
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/applications/app-new'))
    assert.equal(writes[0].url.includes('$ref'), false)
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('a pre-existing registration is restored, never deleted', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({}), NO_CONTENT])
  try {
    await rollback(rollbackContext({ entries: [updated({ owners: [{ id: 'u-new', existed: false }] })] }))

    const methods = writeCalls(calls).map((c) => `${c.method} ${c.url.replace(/^.*\/v1\.0/, '')}`)
    assert.deepEqual(methods, ['PATCH /applications/app-1', 'DELETE /applications/app-1/owners/u-new/$ref'])
    assert.equal(
      methods.includes('DELETE /applications/app-1'),
      false,
      'an app the tenant already had must survive its rollback',
    )
  } finally {
    restore()
  }
})

test('rollback revokes only the owner references this deploy added', async () => {
  const { calls, restore } = routeFetch([
    { url: /\$ref$/, method: 'DELETE', respond: NO_CONTENT },
    { url: /\/applications\/app-1$/, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          updated({
            owners: [
              { id: 'u-added', existed: false },
              { id: 'u-preexisting', existed: true },
            ],
          }),
        ],
      }),
    )

    const revokes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.deepEqual(
      revokes.map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      ['/applications/app-1/owners/u-added/$ref'],
      'an ownership that pre-dated this deploy must survive the rollback',
    )
    // The trailing /$ref de-links the owner; without it Graph deletes the user.
    assert.ok(revokes[0].url.endsWith('/$ref'))
    assert.match(String(result.message), /1 owner\(s\) revoked/)
  } finally {
    restore()
  }
})

test('a registration already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'New API', uniqueName: 'New-API', existed: false, id: 'app-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('a 404 on the restore PATCH is likewise treated as already-undone', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('an updated registration with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Contoso API', uniqueName: 'Contoso-API', existed: true, id: 'app-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no recorded id is skipped rather than addressed blindly', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Contoso API', uniqueName: 'Contoso-API', existed: false }] }),
    )

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback does nothing when the deploy recorded no entries', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})
