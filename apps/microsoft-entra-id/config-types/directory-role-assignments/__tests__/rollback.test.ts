// ============================================================================
// rollback for directory role assignments, against a fake Microsoft Graph.
//
// A unifiedRoleAssignment is immutable, so rollback has exactly one job: revoke
// the grants THIS deployment created. The assertion that matters is the negative
// one — a grant that already existed must survive the rollback, or undoing a bad
// deploy also strips an administrator of a role Veltrix never gave them.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  graphError,
  leaksSecret,
  notFound,
  recordFetch,
  rollbackContext,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'a|b|/', existed: false, id: 'ra-1' }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback revokes the grant the deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'a|b|/', existed: false, id: 'ra-1' }] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'DELETE')
    assert.ok(graphCalls[0].url.includes('/roleManagement/directory/roleAssignments/ra-1'))
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('a grant that already existed is NEVER revoked by a rollback', async () => {
  const { calls, restore } = routeFetch([{ url: /roleAssignments/, method: 'DELETE', respond: NO_CONTENT }])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'pre|existing|/', existed: true, id: 'ra-theirs' },
          { name: 'ours|created|/', existed: false, id: 'ra-ours' },
        ],
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.ok(deletes[0].url.includes('ra-ours'))
    assert.ok(
      !deletes.some((c) => c.url.includes('ra-theirs')),
      'undoing our deploy must not revoke a role the tenant already granted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a grant already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'a|b|/', existed: false, id: 'ra-1' }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'a|b|/', existed: false, id: 'ra-1' }] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
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

test('an entry with no id is skipped rather than aimed at a wrong assignment', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'a|b|/', existed: false }] }))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
