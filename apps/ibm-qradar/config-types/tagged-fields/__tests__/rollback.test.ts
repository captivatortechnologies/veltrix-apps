// rollback for tagged-fields.
//
// The shared contract covers the refusals and "nothing recorded means no call".
// What is specific here: a field deploy CREATED is deleted, and a field it only
// updated is POSTed back to the category_id + description deploy captured —
// never to anything it had to invent, because the two mutable properties are the
// only ones QRadar will accept on an update.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  assertQRadarHeaders,
  bodyOf,
  leaksToken,
  notFound,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  rollbackContext,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

const FIELDS = '/ariel/taggedfields'

registerRollbackGuardContract({ label: 'tagged-fields', handler: rollback })

const UPDATED = {
  itemId: 'item-session',
  name: 'acmeSessionId',
  existed: true,
  id: 31,
  prior: { categoryId: 9, description: 'Old description' },
}

const CREATED = { itemId: 'item-new', name: 'acmeNewField', existed: false, id: 77 }

test('tagged-fields rollback: restores exactly the category and description deploy captured', async () => {
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${FIELDS}/31`)
    assert.deepEqual(bodyOf(calls[0]), { category_id: 9, description: 'Old description' })
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('tagged-fields rollback: deletes a field the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), `${FIELDS}/77`)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('tagged-fields rollback: a 202 or a 404 on the delete is not an error', async () => {
  // 202 is an accepted asynchronous delete; 404 means the field is already gone,
  // which is the state rollback was trying to reach.
  for (const answer of [ACCEPTED, notFound()]) {
    const { restore } = recordFetch([answer])
    try {
      const result = await rollback(rollbackContext({ entries: [CREATED] }))

      assert.equal(result.success, true, `status ${answer.status} must not read as a failed delete`)
      assert.match(String(result.message), /1 deleted/)
    } finally {
      restore()
    }
  }
})

test('tagged-fields rollback: an entry with no recorded id makes no call', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'acmeHalfCreated', existed: false }] }))

    assert.equal(calls.length, 0, 'no id means nothing to address')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tagged-fields rollback: an updated entry with no recorded prior state makes no call', async () => {
  // Restoring an object whose prior state was never captured would mean
  // recategorising the field to a value nobody ever set.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'acmeSessionId', existed: true, id: 31 }] }))

    assert.equal(calls.length, 0, 'no recorded prior means no restore')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tagged-fields rollback: a rejected restore is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([qradarError(403, 'You do not have permission to modify tagged fields')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('tagged-fields rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`DELETE ${FIELDS}/77`, `POST ${FIELDS}/31`],
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
