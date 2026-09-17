// rollback for flow-vlans.
//
// The shared contract covers the refusals (no credential, no console host,
// nothing recorded). What is specific here: there is no update endpoint, so a
// pair that already existed was never modified and must be left completely
// alone — deleting it would destroy a flow classification this app never owned.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  leaksToken,
  notFound,
  pathOf,
  qradarError,
  recordFetch,
  rollbackContext,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/ariel/flow_vlans'

registerRollbackGuardContract({ label: 'flow-vlans', handler: rollback })

const CREATED = { itemId: 'item-guest', label: 'Guest WiFi', pairKey: '10:200', existed: false, id: 5 }
const PRE_EXISTING = { itemId: 'item-core', label: 'Core', pairKey: '30:500', existed: true, id: 9 }

test('flow-vlans rollback: deletes the pairs the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), `${PATH}/5`)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('flow-vlans rollback: leaves a pre-existing pair completely alone', async () => {
  // This pair was in QRadar before the deploy and was never written to — there
  // is no update endpoint. Deleting it would remove a classification the
  // customer configured themselves and rollback cannot put back.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [PRE_EXISTING] }))

    assert.equal(calls.length, 0, 'a pair this deploy did not create must not be touched')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted/)
  } finally {
    restore()
  }
})

test('flow-vlans rollback: an entry with no recorded id makes no call at all', async () => {
  // Deploy could not read the id back from the create response. There is no
  // safe object to address, so rollback must not invent a delete.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ label: 'No Id', pairKey: '10:200', existed: false }] }))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted/)
  } finally {
    restore()
  }
})

test('flow-vlans rollback: a pair already gone is not an error', async () => {
  const { restore } = recordFetch([notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, true, '404 is the state rollback was trying to reach')
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('flow-vlans rollback: a rejected delete is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([qradarError(409, 'Flow VLAN is referenced by a domain')])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /delete Guest WiFi: Flow VLAN is referenced by a domain/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('flow-vlans rollback: undoes every created entry and skips every pre-existing one', async () => {
  const SECOND = { itemId: 'item-lab', label: 'Lab', pairKey: '0:999', existed: false, id: 6 }
  const { calls, restore } = recordFetch([ACCEPTED, ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, PRE_EXISTING, SECOND] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`DELETE ${PATH}/5`, `DELETE ${PATH}/6`],
      'both created pairs are removed and the pre-existing one is skipped',
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /2 deleted/)
  } finally {
    restore()
  }
})
