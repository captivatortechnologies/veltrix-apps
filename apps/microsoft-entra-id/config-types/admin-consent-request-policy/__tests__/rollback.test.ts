// ============================================================================
// rollback for the tenant admin consent request policy.
//
// The singleton cannot be deleted, so rollback is always a restore: PUT back
// the object deploy captured before it wrote. The cases that matter are the
// ones where there is nothing trustworthy to restore — no recorded prior, a
// malformed rollbackData — because a restore that guesses would write the
// canvas values a second time and call it an undo.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertAuthenticatedFirst,
  bodyOf,
  graphError,
  leaksSecret,
  recordFetch,
  resource,
  rollbackContext,
  TOKEN,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const PATH = '/policies/adminConsentRequestPolicy'

/** The prior state a successful deploy records. */
const PRIOR = {
  isEnabled: false,
  notifyReviewers: false,
  remindersEnabled: false,
  requestDurationInDays: 30,
  reviewers: [{ query: '/users/old-reviewer', queryType: 'MicrosoftGraph' }],
}

test('refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true, prior: PRIOR }] }, { credential: null }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('restores the recorded prior state verbatim', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource({})])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true, prior: PRIOR }] }))

    assert.equal(result.success, true)
    const graph = assertAuthenticatedFirst(assert, calls)
    assert.equal(graph.length, 1)
    assert.equal(graph[0].method, 'PUT')
    assert.match(graph[0].url, new RegExp(PATH.replace(/\//g, '\\/')))
    // The write is a full replace, so the body must be the whole captured
    // object — a partial one would reset the fields it omits.
    assert.deepEqual(bodyOf(graph[0]), PRIOR)
  } finally {
    restore()
  }
})

test('does nothing when the deploy recorded no entries', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await rollback(rollbackContext({ entries: [] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('does nothing when there is no rollbackData at all', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a malformed rollbackData is ignored rather than written through', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await rollback(rollbackContext({ entries: 'not-an-array' }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('an entry with no recorded prior is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    // Restoring "something plausible" here would overwrite the tenant policy
    // with an invention. Leaving it is visible and correctable; writing is not.
    const result = await rollback(rollbackContext({ entries: [{ existed: true }] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('an entry deploy marked as not pre-existing is skipped', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: false, prior: PRIOR }] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a rejected restore is reported as a failed result, not thrown', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true, prior: PRIOR }] }))

    assert.equal(result.success, false)
    assert.match(result.message, /Insufficient privileges/)
  } finally {
    restore()
  }
})

test('neither the token nor the client secret reaches the result', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true, prior: PRIOR }] }))

    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
