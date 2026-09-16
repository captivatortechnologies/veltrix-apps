// ============================================================================
// rollback for Entra custom security attribute sets, against a fake Microsoft
// Graph.
//
// This rollback can only ever do HALF a job, and that is by design: Graph
// cannot delete an attribute set, so a set this deploy created stays. What it
// must get right is the other half — restoring the live prior description and
// attribute cap of a set that already existed, and touching nothing else. A
// rollback that "cleaned up" a created set by clearing its fields would be
// inventing a state the tenant never had.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
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

const PRIOR = { description: 'Old wording', maxAttributesPerSet: 10 }

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext(
        { entries: [{ name: 'Engineering', existed: true, id: 'Engineering', prior: PRIOR }] },
        { credential: null },
      ),
    )

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
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Engineering', existed: true, id: 'Engineering', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith('/directory/attributeSets/Engineering'))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('a set the deploy created is left completely untouched — it cannot be deleted', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Engineering', existed: false, id: 'Engineering' }] }),
    )

    assert.equal(calls.length, 0, 'no delete, and no field-clearing PATCH either')
    assert.equal(result.success, true)
    assert.match(String(result.message), /created sets are not deletable/)
  } finally {
    restore()
  }
})

test('a set already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Engineering', existed: true, id: 'Engineering', prior: PRIOR }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('an updated set with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Engineering', existed: true, id: 'Engineering' }] }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no recorded id is skipped entirely', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Engineering', existed: true, prior: PRIOR }] }),
    )

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Engineering', existed: true, id: 'Engineering', prior: PRIOR }] }),
    )

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
