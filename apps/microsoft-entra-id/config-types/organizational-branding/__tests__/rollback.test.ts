// ============================================================================
// rollback for the tenant's default organizational branding.
//
// Branding cannot be deleted, so rollback is always a restore: PATCH back the
// per-field values deploy captured, under the same `Accept-Language: 0` that
// selects the default locale. What it must NOT do is touch the resource when
// the recorded state is incomplete — the entry carries the organization id, and
// without it there is no path to write to.
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

const ORG_ID = '9f3c7a21-4b2e-4d6a-8c11-2a7e5f0b9d43'

/** What a successful deploy records: only the fields it changed. */
const ENTRY = {
  existed: true,
  orgId: ORG_ID,
  prior: { signInPageText: 'Previous notice', backgroundColor: '#ffffff' },
}

test('refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [ENTRY] }, { credential: null }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('restores the recorded fields under the default-locale header', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource({})])
  try {
    const result = await rollback(rollbackContext({ entries: [ENTRY] }))

    assert.equal(result.success, true)
    const graph = assertAuthenticatedFirst(assert, calls)
    assert.equal(graph.length, 1)
    assert.equal(graph[0].method, 'PATCH')
    assert.match(graph[0].url, new RegExp(`/organization/${ORG_ID}/branding`))
    assert.equal(graph[0].acceptLanguage, '0', 'restoring a translation instead of the default is not a restore')
    assert.deepEqual(bodyOf(graph[0]), ENTRY.prior)
  } finally {
    restore()
  }
})

test('restores only the fields the deploy changed', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource({})])
  try {
    await rollback(rollbackContext({ entries: [ENTRY] }))

    // A rollback that sent every managed field would clear branding the deploy
    // never touched, which is a change of its own rather than an undo.
    assert.deepEqual(Object.keys(bodyOf(writeCalls(calls)[0]) ?? {}).sort(), [
      'backgroundColor',
      'signInPageText',
    ])
  } finally {
    restore()
  }
})

test('clears a value the deploy introduced', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource({})])
  try {
    // The tenant had no sign-in text before; the empty string is how rollback
    // puts it back, and it is why deploy records '' rather than omitting it.
    await rollback(rollbackContext({ entries: [{ ...ENTRY, prior: { signInPageText: '' } }] }))

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), { signInPageText: '' })
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

test('an entry with no organization id is skipped rather than written to a blank path', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true, prior: ENTRY.prior }] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, '/organization//branding is not a resource')
  } finally {
    restore()
  }
})

test('an entry with no recorded prior is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await rollback(rollbackContext({ entries: [{ existed: true, orgId: ORG_ID }] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a rejected restore is reported as a failed result, not thrown', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await rollback(rollbackContext({ entries: [ENTRY] }))

    assert.equal(result.success, false)
    assert.match(result.message, /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
