// rollback for reference-map-of-sets.
//
// The shared contract covers the refusals (no credential, no console host,
// nothing recorded). What is specific here: a collection this deploy created is
// deleted; a collection it only updated is reconciled back to the (key, value)
// pairs deploy captured — which means re-reading the live collection first,
// because its membership may have changed again since.
//
// NOTE ON FIXTURES: every key and value below is a single token. `rollback.ts`
// joins a pair into one string with a LITERAL SPACE (lines 33/45/46/52) where
// `deploy.ts:23` uses a NUL, and splits it back apart at line 46 — so a key or
// value containing a space is torn in two and restored as an invented pair.
// That path is deliberately left unasserted rather than pinned as correct; it
// is in the defect report.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  forbidden,
  leaksToken,
  notFound,
  ok,
  pathOf,
  recordFetch,
  rollbackContext,
  serverError,
  transportFailure,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

registerRollbackGuardContract({ label: 'reference-map-of-sets', handler: rollback })

const UPDATED = {
  name: 'Admin Users',
  existed: true,
  elementType: 'ALN',
  priorPairs: [
    ['finance', 'alice'],
    ['ops', 'carol'],
  ],
}

const CREATED = { name: 'New Group', existed: false, elementType: 'ALN', priorPairs: [] }

function liveMapOfSets(name: string, data: Record<string, string[]>) {
  return ok({
    name,
    element_type: 'ALN',
    data: Object.fromEntries(
      Object.entries(data).map(([key, values]) => [key, values.map((value) => ({ value }))]),
    ),
  })
}

test('reference-map-of-sets rollback: restores exactly the pairs deploy captured', async () => {
  // Live is missing one pair the deploy removed and carries one the deploy
  // added. Rollback must put the first back and take the second away.
  const { calls, restore } = recordFetch([
    liveMapOfSets('Admin Users', { finance: ['alice'], ops: ['mallory'] }),
    ok({}),
    ok({}),
  ])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), '/reference_data/map_of_sets/Admin%20Users')
    assert.equal(calls[0].range, 'items=0-9999')
    assert.deepEqual(
      calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/map_of_sets/Admin%20Users?key=ops&value=carol',
        'DELETE /reference_data/map_of_sets/Admin%20Users/ops/mallory',
      ],
      'a pair already in its prior state is not rewritten',
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-map-of-sets rollback: deletes a collection the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), '/reference_data/map_of_sets/New%20Group')
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('reference-map-of-sets rollback: a collection already gone is not an error', async () => {
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

test('reference-map-of-sets rollback: a read it cannot perform fails rather than restoring nothing', async () => {
  // Without the live pairs there is no safe reconcile, so the entry must be
  // reported as failed — not silently skipped as "already correct".
  const { calls, restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(writeCalls(calls).length, 0, 'an unreadable collection must not be written blind')
    assert.equal(result.success, false)
    assert.match(String(result.message), /Internal server error/)
  } finally {
    restore()
  }
})

test('reference-map-of-sets rollback: an unreachable console is a failed result, not a thrown error', async () => {
  const { calls, restore } = recordFetch([transportFailure()])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /ENOTFOUND/)
  } finally {
    restore()
  }
})

test('reference-map-of-sets rollback: a rejected delete is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([forbidden('You do not have permission to delete reference data')])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-map-of-sets rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([
    ACCEPTED,
    liveMapOfSets('Admin Users', { finance: ['alice'], ops: ['carol'] }),
  ])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [
        'DELETE /reference_data/map_of_sets/New%20Group',
        'GET /reference_data/map_of_sets/Admin%20Users',
      ],
      'the created collection is deleted and the updated one is re-read',
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
