// ============================================================================
// rollback for Entra terms of use agreements, against a fake Graph.
//
// The provenance split is what keeps acceptance records safe: an agreement this
// app created is removed, one the tenant already had is PATCHed back to the
// metadata deploy read off it. Deleting a pre-existing agreement would take
// every recorded acceptance with it, which is not recoverable from here.
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

const BASE = '/identityGovernance/termsOfUse/agreements'

/** What deploy read off the live agreement before overwriting it. */
const PRIOR = {
  displayName: 'Acceptable Use Policy',
  isViewingBeforeAcceptanceRequired: true,
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext(
        { entries: [{ name: 'Acceptable Use Policy', existed: true, id: 'a-1', prior: PRIOR }] },
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

test('rollback refuses when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext(
        { entries: [{ name: 'Acceptable Use Policy', existed: true, id: 'a-1', prior: PRIOR }] },
        { settings: {} },
      ),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior metadata captured at deploy', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Acceptable Use Policy', existed: true, id: 'a-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/a-1`))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('a prior that did NOT require viewing is restored as not required', async () => {
  // Restoring the stricter value would be a silent policy change of its own.
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    await rollback(
      rollbackContext({
        entries: [
          {
            name: 'Acceptable Use Policy',
            existed: true,
            id: 'a-1',
            prior: { ...PRIOR, isViewingBeforeAcceptanceRequired: false },
          },
        ],
      }),
    )

    assert.equal(bodyOf(writeCalls(calls)[0])?.isViewingBeforeAcceptanceRequired, false)
  } finally {
    restore()
  }
})

test('rollback deletes an agreement the deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Acceptable Use Policy', existed: false, id: 'a-new' }] }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith(`${BASE}/a-new`))
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('an agreement already gone (404) is treated as already undone, not as an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Acceptable Use Policy', existed: false, id: 'a-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('a 404 on the restore PATCH is likewise not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Acceptable Use Policy', existed: true, id: 'a-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an updated agreement with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Acceptable Use Policy', existed: true, id: 'a-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped — rollback never invents a target', async () => {
  // Guessing here would delete some other tenant agreement, and its acceptances.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Acceptable Use Policy', existed: false }] }),
    )

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
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Acceptable Use Policy', existed: true, id: 'a-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback had errors/)
    assert.match(String(result.message), /restore Acceptable Use Policy: .*Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
