// ============================================================================
// rollback for Entra custom directory role definitions.
//
// The provenance rule is the whole point: a role THIS deploy created is
// deleted, a role that already existed is PATCHed back to the permissions it
// used to carry. Get it backwards and undoing a bad deploy either destroys a
// role the tenant wrote itself or leaves a widened permission set in place.
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
  recordFetch,
  rollbackContext,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const BASE = '/roleManagement/directory/roleDefinitions'

const PRIOR = {
  displayName: 'App Reader',
  description: 'Reads application registrations',
  isEnabled: true,
  rolePermissions: [
    { allowedResourceActions: ['microsoft.directory/applications/basic/read', 'microsoft.directory/groups/basic/read'] },
  ],
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'App Reader', existed: true, id: 'rd-1', prior: PRIOR }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the LIVE prior permissions captured at deploy, verbatim', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'App Reader', existed: true, id: 'rd-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/rd-1`))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a role the deploy created and leaves a pre-existing one restored, not deleted', async () => {
  const { calls, restore } = routeFetch([{ url: /roleDefinitions/, respond: NO_CONTENT }])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'New Role', existed: false, id: 'rd-new' },
          { name: 'App Reader', existed: true, id: 'rd-1', prior: PRIOR },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.deepEqual(
      writes.map((c) => `${c.method} ${c.url.replace(/^.*\/v1\.0/, '')}`),
      [`DELETE ${BASE}/rd-new`, `PATCH ${BASE}/rd-1`],
      'only the role this app created is destroyed; the pre-existing one is put back',
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('a role already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'New Role', existed: false, id: 'rd-new' }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('a restore target already gone (404) is likewise not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'App Reader', existed: true, id: 'rd-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('an updated role with no recorded prior is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'App Reader', existed: true, id: 'rd-1' }] }))

    assert.equal(writeCalls(calls).length, 0, 'a reconstructed permission list is a new permission grant, not a restore')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped rather than aimed at the wrong role', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'New Role', existed: false }] }))

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

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'App Reader', existed: true, id: 'rd-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback had errors/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
