// ============================================================================
// rollback for Conditional Access authentication contexts, against a fake Graph.
//
// The split that matters is provenance. A context this app created is removed;
// one the tenant already had is PATCHed back to the fields deploy read off it.
// Getting that backwards either deletes the handle a live Conditional Access
// policy is built on, or leaves a context the deploy invented in the directory.
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
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const BASE = '/identity/conditionalAccess/authenticationContextClassReferences'

/** What deploy read off the live c3 before overwriting it. */
const PRIOR = {
  displayName: 'High risk step-up',
  description: 'Requires phishing-resistant MFA',
  isAvailable: true,
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'c3', existed: true, id: 'c3', prior: PRIOR }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback refuses when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'c3', existed: true, id: 'c3', prior: PRIOR }] }, { settings: {} }),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior body captured at deploy, isAvailable included', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'c3', existed: true, id: 'c3', prior: PRIOR }] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/c3`))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a context the deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'c7', existed: false, id: 'c7' }] }))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith(`${BASE}/c7`))
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('a context already gone (404) is treated as already undone, not as an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'c7', existed: false, id: 'c7' }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('a 404 on the restore PATCH is likewise not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'c3', existed: true, id: 'c3', prior: PRIOR }] }))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an updated context with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'c3', existed: true, id: 'c3' }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped — rollback never invents a target', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'c3', existed: false }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback does nothing at all when the deploy recorded no rollbackData', async () => {
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
    const result = await rollback(rollbackContext({ entries: [{ name: 'c3', existed: true, id: 'c3', prior: PRIOR }] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback had errors/)
    assert.match(String(result.message), /restore c3: .*Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
