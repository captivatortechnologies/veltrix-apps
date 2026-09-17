// rollback for reference-sets.
//
// The shared contract covers the refusals (no credential, no console host,
// nothing recorded). What is specific here: a set this deploy created is
// deleted; a set it only updated is reconciled back to the values deploy
// captured — which means re-reading the live set first, because values may have
// changed again since.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  leaksToken,
  notFound,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  rollbackContext,
  serverError,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

registerRollbackGuardContract({ label: 'reference-sets', handler: rollback })

const UPDATED = {
  name: 'Blocked Domains',
  existed: true,
  elementType: 'ALN',
  priorValues: ['evil.example', 'added-by-hand.example'],
}

const CREATED = { name: 'New Set', existed: false, elementType: 'ALN', priorValues: [] }

function liveSet(name: string, values: string[]) {
  return ok({ name, element_type: 'ALN', data: values.map((value) => ({ value })) })
}

test('reference-sets rollback: restores exactly the values deploy captured', async () => {
  // Live now holds one of the prior values plus one the deploy added. Rollback
  // must add back what is missing and remove what the deploy introduced.
  const { calls, restore } = recordFetch([liveSet('Blocked Domains', ['evil.example', 'bad.example']), ok({}), ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), '/reference_data/sets/Blocked%20Domains')
    assert.deepEqual(
      calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/sets/Blocked%20Domains?value=added-by-hand.example',
        'DELETE /reference_data/sets/Blocked%20Domains/bad.example',
      ],
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-sets rollback: deletes a set the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), '/reference_data/sets/New%20Set')
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('reference-sets rollback: a set already gone is not an error', async () => {
  // 404 is a known answer: the object rollback would delete is already absent,
  // which is the state it was trying to reach.
  const { restore } = recordFetch([notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('reference-sets rollback: a read it cannot perform fails rather than restoring nothing', async () => {
  // Without the live values there is no safe reconcile, so the entry must be
  // reported as failed — not silently skipped as "already correct".
  const { calls, restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(writeCalls(calls).length, 0, 'an unreadable set must not be written blind')
    assert.equal(result.success, false)
    assert.match(String(result.message), /Internal server error/)
  } finally {
    restore()
  }
})

test('reference-sets rollback: a rejected delete is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([qradarError(403, 'You do not have permission to delete reference data')])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-sets rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, liveSet('Blocked Domains', ['evil.example', 'added-by-hand.example'])])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => c.method),
      ['DELETE', 'GET'],
      'the created set is deleted and the updated set is re-read',
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
