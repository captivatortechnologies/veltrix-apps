// rollback for tenants.
//
// The shared contract covers the refusals and the "nothing recorded, nothing
// written" rule. What is specific here: a tenant deploy created is deleted, and
// a tenant deploy only updated is restored by POSTing the prior state back to
// the same id — including the rate caps, which are what an operator notices
// when a rollback puts back the name but not the throughput.

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

const COLLECTION = '/config/access/tenant_management/tenants'

registerRollbackGuardContract({ label: 'tenants', handler: rollback })

const UPDATED = {
  itemId: 'itm-research',
  name: 'Research',
  existed: true,
  id: 7,
  prior: {
    name: 'Research',
    description: 'edited by hand in the console',
    eventRateLimit: 9000,
    flowRateLimit: 2500,
  },
}

const CREATED = { itemId: 'itm-new', name: 'New Tenant', existed: false, id: 42 }

test('tenants rollback: restores exactly the prior state deploy captured, rate caps included', async () => {
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${COLLECTION}/7`)
    assert.deepEqual(bodyOf(calls[0]), {
      name: 'Research',
      description: 'edited by hand in the console',
      event_rate_limit: 9000,
      flow_rate_limit: 2500,
    })
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('tenants rollback: deletes a tenant the deploy created', async () => {
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

test('tenants rollback: an already-gone tenant (404) and an accepted async delete (202) are not errors', async () => {
  // Both are known answers: 404 means the state rollback wanted is already
  // reached, and QRadar deletes tenants asynchronously with a 202.
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

test('tenants rollback: an entry with no recorded id makes no call at all', async () => {
  // Without the QRadar id there is nothing to address, and guessing by name
  // could delete a tenant — and its data separation — that the app never created.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'x', existed: false }] }))

    assert.equal(calls.length, 0, 'an idless entry must not be guessed at')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tenants rollback: a rejected restore is a failed result, not a thrown error', async () => {
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

test('tenants rollback: undoes every recorded entry, not just the first', async () => {
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
