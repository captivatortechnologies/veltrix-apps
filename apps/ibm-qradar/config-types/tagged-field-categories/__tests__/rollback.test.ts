// rollback for tagged-field-categories.
//
// The shared contract covers the refusals and the "nothing recorded, nothing
// written" rule. What is specific here: a category deploy created is deleted,
// and a category deploy only renamed is renamed back by POSTing the prior name
// to the same id. Deleting a category takes the custom Ariel properties filed
// under it with it, so an entry marked `existed: true` must never be deleted.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  assertQRadarHeaders,
  bodyOf,
  forbidden,
  leaksToken,
  notFound,
  ok,
  pathOf,
  recordFetch,
  rollbackContext,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

const COLLECTION = '/ariel/taggedfieldcategories'

registerRollbackGuardContract({ label: 'tagged-field-categories', handler: rollback })

const UPDATED = {
  itemId: 'itm-username',
  name: 'Username',
  existed: true,
  id: 7,
  prior: { name: 'username-created-by-hand' },
}

const CREATED = { itemId: 'itm-new', name: 'New Category', existed: false, id: 42 }

test('tagged-field-categories rollback: restores exactly the prior name deploy captured', async () => {
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${COLLECTION}/7`)
    assert.deepEqual(bodyOf(calls[0]), { name: 'username-created-by-hand' })
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('tagged-field-categories rollback: deletes a category the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), `${COLLECTION}/42`)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('tagged-field-categories rollback: an already-gone category (404) and an accepted async delete (202) are not errors', async () => {
  // Both are known answers: 404 means the state rollback wanted is already
  // reached, and the console accepts the delete asynchronously with a 202.
  for (const response of [notFound(), ACCEPTED]) {
    const { restore } = recordFetch([response])
    try {
      const result = await rollback(rollbackContext({ entries: [CREATED] }))

      assert.equal(result.success, true, `status ${response.status} must not read as a failure`)
      assert.match(String(result.message), /1 deleted/)
    } finally {
      restore()
    }
  }
})

test('tagged-field-categories rollback: an entry with no recorded id makes no call at all', async () => {
  // Without the QRadar id there is nothing to address, and guessing by name
  // could delete a category — and the properties filed under it — that the app
  // never created.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'x', existed: false }] }))

    assert.equal(calls.length, 0, 'an idless entry must not be guessed at')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tagged-field-categories rollback: a rejected restore is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([forbidden('You do not have the required capability for this endpoint')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /required capability/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('tagged-field-categories rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`DELETE ${COLLECTION}/42`, `POST ${COLLECTION}/7`],
    )
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
