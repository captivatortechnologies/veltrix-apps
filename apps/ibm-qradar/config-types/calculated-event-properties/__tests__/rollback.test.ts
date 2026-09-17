// rollback for calculated-event-properties.
//
// The shared contract covers the refusals and "nothing recorded means no call".
// What is specific here: the restore PUTs back the whole prior state object —
// operands included — so this asserts the operand bodies survive the round trip
// exactly as deploy captured them from the console.

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

const PATH = '/config/event_sources/custom_properties/calculated_properties'

registerRollbackGuardContract({ label: 'calculated-event-properties', handler: rollback })

const PRIOR = {
  name: 'Bytes Per Packet',
  description: 'Edited in the console',
  enabled: false,
  operator: 'MULTIPLY',
  first_operand: { type: 'PROPERTY', property_name: 'Bytes' },
  second_operand: { type: 'STATIC', numeric_value: 8 },
}

const UPDATED = { itemId: 'item-ratio', name: 'Bytes Per Packet', existed: true, id: 21, prior: PRIOR }

const CREATED = { itemId: 'item-new', name: 'Megabytes', existed: false, id: 55 }

test('calculated-event-properties rollback: restores the whole prior state, operands included', async () => {
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${PATH}/21`)
    assert.deepEqual(bodyOf(calls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('calculated-event-properties rollback: deletes a property the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), `${PATH}/55`)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('calculated-event-properties rollback: a 202 or a 404 on the delete is not an error', async () => {
  // 202 is an accepted asynchronous delete; 404 means the property is already
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

test('calculated-event-properties rollback: an entry with no recorded id makes no call', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Half Created', existed: false }] }))

    assert.equal(calls.length, 0, 'no id means nothing to address')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('calculated-event-properties rollback: an updated entry with no recorded prior state makes no call', async () => {
  // Without the captured state there is no expression to put back, and an
  // invented one would change what the property computes.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Bytes Per Packet', existed: true, id: 21 }] }))

    assert.equal(calls.length, 0, 'no recorded prior means no restore')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('calculated-event-properties rollback: a rejected restore is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([qradarError(403, 'You do not have permission to modify custom properties')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('calculated-event-properties rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`DELETE ${PATH}/55`, `POST ${PATH}/21`],
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
