// ============================================================================
// rollback for Entra activity based timeout policies, against a fake Graph.
//
// Restoring the prior body is what puts the tenant's original idle timeout — and
// its organization-default flag — back. A rollback that re-sent the canvas values
// would leave the shortened (or lengthened) session lifetime it was asked to undo.
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

const BASE = '/policies/activityBasedTimeoutPolicies'

const EIGHT_HOURS =
  '{"ActivityBasedTimeoutPolicy":{"Version":1,"ApplicationPolicies":[{"ApplicationId":"default","WebSessionIdleTimeout":"08:00:00"}]}}'

/** What deploy read off the live policy before overwriting it. */
const PRIOR = {
  displayName: 'Kiosk timeout',
  definition: [EIGHT_HOURS],
  isOrganizationDefault: true,
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext(
        { entries: [{ name: 'Kiosk timeout', existed: true, id: 'p-1', prior: PRIOR }] },
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
      rollbackContext({ entries: [{ name: 'Kiosk timeout', existed: true, id: 'p-1', prior: PRIOR }] }, { settings: {} }),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior body captured at deploy, definition text and all', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Kiosk timeout', existed: true, id: 'p-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/p-1`))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a policy the deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Kiosk timeout', existed: false, id: 'p-new' }] }))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith(`${BASE}/p-new`))
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('a policy already gone (404) is treated as already undone, not as an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Kiosk timeout', existed: false, id: 'p-new' }] }))

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
      rollbackContext({ entries: [{ name: 'Kiosk timeout', existed: true, id: 'p-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an updated policy with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Kiosk timeout', existed: true, id: 'p-1' }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped — rollback never invents a target', async () => {
  // A create whose response carried no id leaves nothing safe to delete;
  // guessing an id here would delete some other tenant policy.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Kiosk timeout', existed: false }] }))

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
      rollbackContext({ entries: [{ name: 'Kiosk timeout', existed: true, id: 'p-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback had errors/)
    assert.match(String(result.message), /restore Kiosk timeout: .*Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
