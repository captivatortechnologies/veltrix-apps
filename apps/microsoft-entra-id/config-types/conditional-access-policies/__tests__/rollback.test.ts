// ============================================================================
// rollback for Conditional Access policies, against a fake Microsoft Graph.
//
// Rollback is the handler nobody exercises until the day it is the only thing
// standing between a bad deploy and a locked-out tenant. The contract it has to
// keep: restore the LIVE state captured at deploy time (never the canvas's
// desired values), delete only what this app created, and never guess when the
// prior state was not recorded.
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

const POLICIES = '/identity/conditionalAccess/policies'

/** What deploy snapshots for a policy it UPDATED: the tenant's own prior body. */
const PRIOR = {
  displayName: 'Require MFA',
  state: 'disabled',
  conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] } },
  grantControls: { operator: 'AND', builtInControls: ['block'] },
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Require MFA', existed: false, id: 'p-1' }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('rollback restores the live prior body captured at deploy, not the canvas values', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [{ name: 'Require MFA', existed: true, id: 'p-1', prior: PRIOR }],
      }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.includes(`${POLICIES}/p-1`))
    // Byte-for-byte the state the tenant was in before the deploy touched it.
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a policy the deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'New Policy', existed: false, id: 'p-new' }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'DELETE')
    assert.ok(graphCalls[0].url.includes(`${POLICIES}/p-new`))
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('a policy already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'New Policy', existed: false, id: 'p-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Require MFA', existed: true, id: 'p-1', prior: PRIOR }] }),
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
    assert.equal(calls.length, 0, 'nothing recorded means nothing to undo — not even a token exchange')
  } finally {
    restore()
  }
})

test('an updated policy with no recorded prior state is left alone, never guessed at', async () => {
  // `existed: true` with no `prior` means deploy failed to snapshot the live
  // body. Writing SOMETHING would be worse than writing nothing.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Require MFA', existed: true, id: 'p-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped rather than aimed at a wrong policy', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Require MFA', existed: false }] }))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
