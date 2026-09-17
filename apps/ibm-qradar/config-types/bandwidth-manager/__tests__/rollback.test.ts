// rollback for bandwidth-manager.
//
// The shared contract covers the refusals and the "nothing recorded, nothing
// written" rule. What is specific here: a configuration deploy created is
// deleted, and one deploy only updated is restored by POSTing the prior state
// back to the same id. The cap itself is the point — a rollback that restores
// the name but not `kb_limit` leaves the appliance shaped at the value the
// failed deploy pushed.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  NO_CONTENT,
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

const COLLECTION = '/bandwidth_manager/configurations'

registerRollbackGuardContract({ label: 'bandwidth-manager', handler: rollback })

const UPDATED = {
  itemId: 'itm-edge',
  name: 'Edge Cap',
  existed: true,
  id: 7,
  prior: {
    name: 'Edge Cap',
    hostname: 'ep1.example.test',
    host_id: 3,
    kb_limit: 20000,
    device_name: 'eth1',
  },
}

const CREATED = { itemId: 'itm-new', name: 'New Cap', existed: false, id: 42 }

test('bandwidth-manager rollback: restores exactly the prior state deploy captured, cap included', async () => {
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${COLLECTION}/7`)
    assert.deepEqual(bodyOf(calls[0]), {
      name: 'Edge Cap',
      host_id: 3,
      hostname: 'ep1.example.test',
      device_name: 'eth1',
      kb_limit: 20000,
    })
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('bandwidth-manager rollback: deletes a configuration the deploy created', async () => {
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

test('bandwidth-manager rollback: 404, 202 and 204 on a delete are all known answers, not errors', async () => {
  // 404 means the state rollback wanted is already reached; 202 and 204 are the
  // console accepting the delete. Any of them read as a failure would leave a
  // red rollback nobody can act on.
  for (const response of [notFound(), ACCEPTED, NO_CONTENT]) {
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

test('bandwidth-manager rollback: an entry with no recorded id makes no call at all', async () => {
  // Without the QRadar id there is nothing to address, and guessing by name
  // could delete a shaping rule the app never created.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'x', existed: false }] }))

    assert.equal(calls.length, 0, 'an idless entry must not be guessed at')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('bandwidth-manager rollback: a rejected restore is a failed result, not a thrown error', async () => {
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

test('bandwidth-manager rollback: undoes every recorded entry, not just the first', async () => {
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
