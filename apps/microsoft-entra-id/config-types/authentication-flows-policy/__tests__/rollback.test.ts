// ============================================================================
// rollback for the Entra authentication flows policy, against a fake Graph.
//
// The singleton cannot be deleted, so rollback has exactly one job: PATCH the
// prior `selfServiceSignUp` facet back. If it ever re-sent the canvas value it
// would leave the self-registration door it was asked to close standing open.
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
  recordFetch,
  rollbackContext,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const PATH = '/policies/authenticationFlowsPolicy'

/** What deploy recorded: the tenant HAD self-service sign-up enabled. */
const PRIOR = { selfServiceSignUp: { isEnabled: true } }

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ existed: true, prior: PRIOR }] }, { credential: null }),
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
    const result = await rollback(rollbackContext({ entries: [{ existed: true, prior: PRIOR }] }, { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback PATCHes back exactly the live prior body deploy captured', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true, prior: PRIOR }] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(PATH), `PATCH target was ${graphCalls[0].url}`)
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('a recorded prior of disabled is restored just as faithfully as one of enabled', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    await rollback(rollbackContext({ entries: [{ existed: true, prior: { selfServiceSignUp: { isEnabled: false } } }] }))

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), { selfServiceSignUp: { isEnabled: false } })
  } finally {
    restore()
  }
})

test('an entry with no recorded prior is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 restored/)
  } finally {
    restore()
  }
})

test('the singleton is never deleted — an entry marked not-existed writes nothing', async () => {
  // Graph has no DELETE for this policy; an entry that somehow claims the
  // handler created it must still not turn into a destructive call.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: false, prior: PRIOR }] }))

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
    const result = await rollback(rollbackContext({ entries: [{ existed: true, prior: PRIOR }] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback had errors/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
