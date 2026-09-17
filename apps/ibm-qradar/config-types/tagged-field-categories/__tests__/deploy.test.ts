// deploy for tagged-field-categories.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the list-then-match flow: ONE range-paged read of the collection, a match by
// previously recorded id and then by lowercased name, POST to `.../{id}` to
// rename or to the collection to create, and a rollback entry carrying the LIVE
// prior name. A category is the grouping custom Ariel properties are filed
// under, so a duplicate created alongside an existing one splits the properties
// searches depend on across two groups.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACCEPTED,
  assertQRadarHeaders,
  bodyOf,
  created,
  deployContext,
  item,
  leaksToken,
  list,
  pathOf,
  qradarError,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const COLLECTION = '/ariel/taggedfieldcategories'

const USERNAME = item('Username', { name: 'Username' }, 'itm-username')

registerDeployGuardContract({ label: 'tagged-field-categories', handler: deploy, sampleItems: [USERNAME] })

/** A live category as `GET /ariel/taggedfieldcategories` returns it. */
function liveCategory(over: Record<string, unknown> = {}) {
  return { id: 7, name: 'Username', uuid: 'c0ffee', creation_date: 1700000000000, ...over }
}

test('tagged-field-categories deploy: reads the whole collection once, then creates a category that is absent', async () => {
  const { calls, restore } = recordFetch([
    list([liveCategory({ id: 1, name: 'Unrelated' })]),
    created({ id: 42, name: 'Username' }),
  ])
  try {
    const result = await deploy(deployContext([USERNAME]))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 2, 'one list read, one write')
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), COLLECTION)
    assert.equal(calls[0].range, 'items=0-9999', 'the whole category list is read, not the first page')

    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), COLLECTION, 'a create posts to the collection, not to an id')
    assert.deepEqual(bodyOf(calls[1]), { name: 'Username' })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: 'itm-username', name: 'Username', existed: false, id: 42 }])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('tagged-field-categories deploy: updates a matched category and records the LIVE prior name', async () => {
  // Matching is case-insensitive but the stored name is not: the live category
  // was created as "username" by hand. The name is the only mutable field here,
  // so it is also the whole of the prior state — recording the canvas spelling
  // instead would make rollback rename the operator's category rather than put
  // its own spelling back.
  const { calls, restore } = recordFetch([list([liveCategory({ name: 'username' })]), ACCEPTED])
  try {
    const result = await deploy(deployContext([USERNAME]))

    assert.equal(calls.length, 2)
    assert.equal(pathOf(calls[1]), `${COLLECTION}/7`, 'an update posts to the matched id')
    assert.deepEqual(bodyOf(calls[1]), { name: 'Username' })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 7)
    assert.deepEqual(entries[0].prior, { name: 'username' }, 'rollback state is what was live before the write')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tagged-field-categories deploy: writes nothing when the live category already matches, but still records rollback state', async () => {
  const { calls, restore } = recordFetch([list([liveCategory()])])
  try {
    const result = await deploy(deployContext([USERNAME]))

    assert.equal(writeCalls(calls).length, 0, 'a matching live category needs no write')
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the category is still under management, so rollback must know its state')
    assert.equal(entries[0].existed, true)
    assert.deepEqual(entries[0].prior, { name: 'Username' })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tagged-field-categories deploy: matches by the recorded id when the category was renamed in the console', async () => {
  // Without id matching this creates a SECOND category, and the custom
  // properties filed under the renamed one stay outside the canvas's control.
  const { calls, restore } = recordFetch([list([liveCategory({ name: 'Renamed In Console' })]), ACCEPTED])
  try {
    const result = await deploy(
      deployContext([USERNAME], {
        priorRollbackData: {
          entries: [
            { itemId: 'itm-username', name: 'Username', existed: true, id: 7, prior: { name: 'Username' } },
          ],
        },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'exactly one write — an update, not a second create')
    assert.equal(pathOf(writes[0]), `${COLLECTION}/7`)
    assert.deepEqual(bodyOf(writes[0]), { name: 'Username' })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].id, 7)
    assert.deepEqual(entries[0].prior, { name: 'Renamed In Console' })
  } finally {
    restore()
  }
})

test('tagged-field-categories deploy: a rejected write is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([list([]), qradarError(422, 'A category with that name already exists')])
  try {
    const result = await deploy(deployContext([USERNAME]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already exists/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('tagged-field-categories deploy: deletes a category it created before and no longer declares, never one that pre-existed', async () => {
  const { calls, restore } = routeFetch(
    [
      { url: /\/taggedfieldcategories\/11$/, method: 'DELETE', respond: ACCEPTED },
      { url: /\/taggedfieldcategories$/, method: 'GET', respond: list([liveCategory()]) },
    ],
    ACCEPTED,
  )
  try {
    const result = await deploy(
      deployContext([USERNAME], {
        priorRollbackData: {
          entries: [
            { name: 'Retired', existed: false, id: 11 },
            { name: 'Operator Owned', existed: true, id: 12, prior: { name: 'Operator Owned' } },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${COLLECTION}/11`])
    assert.equal(
      deletes.some((p) => p.endsWith('/12')),
      false,
      'a category that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tagged-field-categories deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = recordFetch([list([liveCategory()])])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})

test('tagged-field-categories deploy: reads the canvas item name when no name field is set', async () => {
  const { calls, restore } = recordFetch([list([]), created({ id: 5 })])
  try {
    await deploy(deployContext([item('Fallback Name', {})]))

    assert.deepEqual(bodyOf(calls[1]), { name: 'Fallback Name' })
  } finally {
    restore()
  }
})
