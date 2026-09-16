// ============================================================================
// rollback for Entra oauth2 permission grants, against a fake Microsoft Graph.
//
// A grant is delegated consent. Rolling one back is how an over-broad scope
// gets taken away again, so the handler has exactly two jobs and both are
// asserted here: narrow an updated grant back to the scope the tenant HAD at
// deploy time (never to whatever the canvas said), and delete outright only the
// grants this deploy created — a grant an administrator consented to by hand is
// not this app's to revoke.
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
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const KEY = '11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222|allprincipals|'
/** The live scope deploy captured before widening the grant. */
const PRIOR = { scope: 'User.Read' }

function updated(over: Record<string, unknown> = {}) {
  return { name: KEY, existed: true, id: 'g-1', prior: PRIOR, ...over }
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

test('rollback narrows the grant back to the live prior scope captured at deploy', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith('/oauth2PermissionGrants/g-1'))
    // Exactly the recorded prior — a rollback that re-sent the canvas scope
    // would leave the widened consent in place.
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a grant the deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: KEY, existed: false, id: 'g-new' }] }))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/oauth2PermissionGrants/g-new'))
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('a grant an administrator consented to by hand is restored, never deleted', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    await rollback(rollbackContext({ entries: [updated()] }))

    assert.equal(
      writeCalls(calls).some((c) => c.method === 'DELETE'),
      false,
      'pre-existing consent must survive a rollback',
    )
  } finally {
    restore()
  }
})

test('a grant already revoked (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: KEY, existed: false, id: 'g-new' }] }))

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

test('an updated grant with no recorded prior scope is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: KEY, existed: true, id: 'g-1' }] }))

    assert.equal(writeCalls(calls).length, 0, 'guessing a scope here would itself be a consent change')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no recorded id is skipped rather than addressed blindly', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: KEY, existed: false }] }))

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
