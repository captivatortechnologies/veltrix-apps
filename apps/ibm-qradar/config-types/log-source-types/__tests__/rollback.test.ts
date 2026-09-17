// rollback for log-source-types.
//
// The shared contract covers the refusals and "nothing recorded means no call".
// What is specific here: a type deploy CREATED is deleted, a type it only
// updated is POSTed back to the prior name + protocol id deploy captured, and an
// entry carrying neither an id nor a prior must produce no request at all —
// writing an invented value is worse than leaving the object as it is.

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

const TYPES = '/config/event_sources/log_source_management/log_source_types'

registerRollbackGuardContract({ label: 'log-source-types', handler: rollback })

const UPDATED = {
  itemId: 'item-acme',
  name: 'Acme Firewall',
  existed: true,
  id: 44,
  prior: { name: 'Acme Firewall', default_protocol_id: 3 },
}

const CREATED = { itemId: 'item-new', name: 'New DSM', existed: false, id: 101 }

test('log-source-types rollback: restores the protocol id deploy captured, not the deployed one', async () => {
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${TYPES}/44`)
    assert.deepEqual(bodyOf(calls[0]), { name: 'Acme Firewall', default_protocol_id: 3 })
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('log-source-types rollback: deletes a type the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), `${TYPES}/101`)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('log-source-types rollback: a 202 or a 404 on the delete is not an error', async () => {
  // 202 is an accepted asynchronous delete; 404 means the object is already
  // gone, which is exactly the state rollback was trying to reach.
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

test('log-source-types rollback: an entry with no recorded id makes no call', async () => {
  // The create was rejected, or the console answered without an id. There is
  // nothing to address, so a DELETE would be aimed at a guess.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Half Created', existed: false }] }))

    assert.equal(calls.length, 0, 'no id means no request')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('log-source-types rollback: an updated entry with no recorded prior state makes no call', async () => {
  // Restoring an object whose prior state was never captured would mean writing
  // a value nobody ever had.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Acme Firewall', existed: true, id: 44 }] }))

    assert.equal(calls.length, 0, 'no recorded prior means no restore')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('log-source-types rollback: a prior with no protocol id restores the name alone', async () => {
  // The type had no default protocol before the deploy set one. The restore
  // must not invent an id to put back.
  const { calls, restore } = recordFetch([ok({})])
  try {
    await rollback(
      rollbackContext({ entries: [{ name: 'Acme Firewall', existed: true, id: 44, prior: { name: 'Acme Firewall' } }] }),
    )

    assert.deepEqual(bodyOf(calls[0]), { name: 'Acme Firewall' })
  } finally {
    restore()
  }
})

test('log-source-types rollback: a rejected restore is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([qradarError(403, 'You do not have permission to modify log source types')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('log-source-types rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`DELETE ${TYPES}/101`, `POST ${TYPES}/44`],
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
