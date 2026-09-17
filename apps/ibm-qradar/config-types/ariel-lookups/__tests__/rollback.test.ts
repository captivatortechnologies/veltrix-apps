// rollback for ariel-lookups.
//
// The shared contract covers the refusals and "nothing recorded means no call".
// What is specific here: identity is the NAME in the URL path, so a lookup this
// deploy created is deleted by name and a lookup it only updated is POSTed back
// to the default value and map deploy read off the console.
//
// NOTE: there is deliberately no test for an `existed: true` entry that carries
// no recorded prior — this handler writes an empty map for it rather than
// skipping it, which would blank the operator's lookup. That is in the defect
// report; asserting it here would document it as correct.

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

const PATH = '/ariel/lookups'

registerRollbackGuardContract({ label: 'ariel-lookups', handler: rollback })

const UPDATED = {
  itemId: 'item-dept',
  name: 'department_lookup',
  existed: true,
  type: 'String',
  priorDefaultValue: 'unassigned',
  priorEntries: [
    { key: 'hr', value: 'Human Resources' },
    { key: 'legacy', value: 'Legacy Dept' },
  ],
}

const CREATED = { itemId: 'item-new', name: 'New Lookup', existed: false, type: 'String', priorDefaultValue: '', priorEntries: [] }

test('ariel-lookups rollback: restores the default value and the map deploy captured', async () => {
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${PATH}/department_lookup`)
    assert.deepEqual(bodyOf(calls[0]), {
      default_value: 'unassigned',
      map: { hr: 'Human Resources', legacy: 'Legacy Dept' },
    })
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('ariel-lookups rollback: deletes a lookup the deploy created, by its URL-encoded name', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), `${PATH}/New%20Lookup`)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('ariel-lookups rollback: a 202 or a 404 on the delete is not an error', async () => {
  // 202 is an accepted asynchronous delete; 404 means the lookup is already
  // gone, which is the state rollback was trying to reach.
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

test('ariel-lookups rollback: a rejected restore is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([qradarError(403, 'You do not have permission to modify Ariel lookups')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('ariel-lookups rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`DELETE ${PATH}/New%20Lookup`, `POST ${PATH}/department_lookup`],
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
