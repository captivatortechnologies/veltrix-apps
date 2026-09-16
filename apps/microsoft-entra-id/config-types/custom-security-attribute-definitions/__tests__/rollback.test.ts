// ============================================================================
// rollback for Entra custom security attribute definitions, against a fake
// Microsoft Graph.
//
// A definition cannot be deleted, so "undoing a create" here means PATCHing it
// to Deprecated — the one config type in this app whose rollback issues no
// DELETE at all. Undoing an UPDATE restores the live prior status /
// description / usePreDefinedValuesOnly captured at deploy time, which matters
// because re-activating a deprecated attribute is itself a directory change.
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
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const ID = 'Engineering_Sensitivity'
const PRIOR = { status: 'Deprecated', usePreDefinedValuesOnly: false, description: 'Old wording' }

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: ID, existed: false, id: ID }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior status captured at deploy, not the canvas values', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: ID, existed: true, id: ID, prior: PRIOR }] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`/directory/customSecurityAttributeDefinitions/${ID}`))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deprecated, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deprecates a definition the deploy created — it never issues a delete', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: ID, existed: false, id: ID }] }))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH', 'a definition cannot be deleted, only deactivated')
    assert.ok(writes[0].url.endsWith(`/directory/customSecurityAttributeDefinitions/${ID}`))
    assert.deepEqual(bodyOf(writes[0]), { status: 'Deprecated' })
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deprecated, 0 restored/)
  } finally {
    restore()
  }
})

test('a definition already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: ID, existed: false, id: ID }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deprecated/)
  } finally {
    restore()
  }
})

test('an updated definition with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: ID, existed: true, id: ID }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no recorded id is skipped entirely', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: ID, existed: false, prior: PRIOR }] }))

    assert.equal(vendorCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: ID, existed: true, id: ID, prior: PRIOR }] }))

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
