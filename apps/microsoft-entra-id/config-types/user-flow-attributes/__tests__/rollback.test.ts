// ============================================================================
// rollback for custom user-flow attributes, against a fake Graph.
//
// Deleting an attribute takes its collected values with it, so this handler only
// ever deletes what THIS deploy created (existed:false); an attribute that was
// already in the directory is patched back to the description deploy read from
// it, and one with no recorded prior is not touched at all.
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

const BASE = '/identity/userFlowAttributes'
const CUSTOM_ID = 'extension_8a2b1c_shoeSize'
const PRIOR = { description: 'Whatever the portal says today' }

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Shoe size', existed: false, id: CUSTOM_ID }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior description captured at deploy', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Shoe size', existed: true, id: CUSTOM_ID, prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/${CUSTOM_ID}`))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes an attribute the deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Shoe size', existed: false, id: CUSTOM_ID }] }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith(`${BASE}/${CUSTOM_ID}`))
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('a pre-existing attribute is restored while an app-created one is deleted', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'Shoe size', existed: true, id: CUSTOM_ID, prior: PRIOR },
          { name: 'Hat size', existed: false, id: 'extension_8a2b1c_hatSize' },
        ],
      }),
    )

    assert.deepEqual(
      writeCalls(calls).map((c) => `${c.method} ${c.url.replace(/^.*\/v1\.0/, '')}`),
      [`PATCH ${BASE}/${CUSTOM_ID}`, `DELETE ${BASE}/extension_8a2b1c_hatSize`],
    )
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('an attribute already gone (404) is treated as already undone', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Shoe size', existed: false, id: CUSTOM_ID }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('an updated attribute with no recorded prior is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Shoe size', existed: true, id: CUSTOM_ID }] }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped rather than addressed by name', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Shoe size', existed: false }] }))

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
      rollbackContext({ entries: [{ name: 'Shoe size', existed: true, id: CUSTOM_ID, prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /restore Shoe size/)
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
