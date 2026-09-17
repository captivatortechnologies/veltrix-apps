// rollback for reference-maps.
//
// The shared contract covers the refusals (no credential, no console host,
// nothing recorded). What is specific here: a map this deploy created is
// deleted; a map it only updated is reconciled back to the entries deploy
// captured — which means re-reading the live map first, because entries may
// have changed again since.

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

registerRollbackGuardContract({ label: 'reference-maps', handler: rollback })

const UPDATED = {
  name: 'Host Map',
  existed: true,
  elementType: 'ALN',
  priorEntries: [
    { key: '10.0.0.1', value: 'web-server' },
    { key: '10.0.0.9', value: 'added-by-hand' },
  ],
}

const CREATED = { name: 'New Map', existed: false, elementType: 'ALN', priorEntries: [] }

function liveMap(name: string, pairs: Record<string, string>) {
  return ok({
    name,
    element_type: 'ALN',
    data: Object.fromEntries(Object.entries(pairs).map(([key, value]) => [key, { value }])),
  })
}

test('reference-maps rollback: restores exactly the entries deploy captured', async () => {
  // Live now holds one of the prior keys (repointed) plus one the deploy added,
  // and is missing one the deploy removed. Rollback must put back every prior
  // pair and remove what the deploy introduced.
  const { calls, restore } = recordFetch([
    liveMap('Host Map', { '10.0.0.1': 'web-server', '10.0.0.2': 'db-server' }),
    ok({}),
    ok({}),
    ok({}),
  ])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), '/reference_data/maps/Host%20Map')
    assert.equal(calls[0].range, 'items=0-9999')

    const writes = calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`)
    assert.ok(
      writes.includes('POST /reference_data/maps/Host%20Map?key=10.0.0.9&value=added-by-hand'),
      `the entry the deploy removed must be put back: ${writes.join(', ')}`,
    )
    assert.ok(
      writes.includes('DELETE /reference_data/maps/Host%20Map/10.0.0.2'),
      `the entry the deploy added must be removed: ${writes.join(', ')}`,
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-maps rollback: deletes a map the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), '/reference_data/maps/New%20Map')
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('reference-maps rollback: a map already gone is not an error', async () => {
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

test('reference-maps rollback: a read it cannot perform fails rather than restoring nothing', async () => {
  // Without the live entries there is no safe reconcile, so the entry must be
  // reported as failed — not silently skipped as "already correct".
  const { calls, restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(writeCalls(calls).length, 0, 'an unreadable map must not be written blind')
    assert.equal(result.success, false)
    assert.match(String(result.message), /Internal server error/)
  } finally {
    restore()
  }
})

test('reference-maps rollback: an unreachable console is a failed result, not a thrown error', async () => {
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

test('reference-maps rollback: a rejected delete is a failed result, not a thrown error', async () => {
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

test('reference-maps rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([
    ACCEPTED,
    liveMap('Host Map', { '10.0.0.1': 'web-server', '10.0.0.9': 'added-by-hand' }),
    ok({}),
    ok({}),
  ])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.slice(0, 2).map((c) => `${c.method} ${pathOf(c)}`),
      ['DELETE /reference_data/maps/New%20Map', 'GET /reference_data/maps/Host%20Map'],
      'the created map is deleted and the updated map is re-read',
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
