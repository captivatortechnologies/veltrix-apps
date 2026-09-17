// rollback for zia-static-ips.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: the restore body is
// rebuilt field by field from the recorded prior — including `routableIP`, whose
// default is the opposite of what a hand-disabled static IP carries — a static IP
// deploy created is deleted, a 404 is not an error, and the revert is itself a
// staged ZIA change.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACTIVATED,
  NO_CONTENT,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  resourceCalls,
  rollbackContext,
  ziaError,
} from '../../../lib/__tests__/fakeZscaler'
import { registerRollbackGuardContract } from '../../../lib/__tests__/zscalerContracts'

registerRollbackGuardContract({
  label: 'zia-static-ips',
  handler: rollback,
  product: 'zia',
  nameKey: 'ipAddress',
})

const UPDATED_ENTRY = {
  ipAddress: '203.0.113.10',
  existed: true,
  id: 4242,
  prior: {
    ipAddress: '203.0.113.10',
    comment: 'legacy comment set by hand',
    geoOverride: true,
    latitude: 51.5074,
    longitude: -0.1278,
    routableIP: false,
  },
}

const CREATED_ENTRY = { ipAddress: '198.51.100.7', existed: false, id: 8801 }

test('zia-static-ips rollback: restores the prior body of a static IP deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 4242 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/staticIP\/4242$/)
    const body = bodyOf(tenant[0])
    assert.equal(body?.comment, 'legacy comment set by hand', 'the recorded prior, not a default')
    assert.equal(body?.geoOverride, true)
    assert.equal(body?.latitude, 51.5074)
    assert.equal(body?.longitude, -0.1278)
    assert.equal(body?.routableIP, false, 'ZIA defaults this true — the prior value must win')

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-static-ips rollback: restores no coordinates when the prior had no geo override', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 4242 }), ACTIVATED])
  try {
    const entry = {
      ...UPDATED_ENTRY,
      prior: { ...UPDATED_ENTRY.prior, geoOverride: false },
    }
    const result = await rollback(rollbackContext({ previousState: [entry] }))

    const body = bodyOf(resourceCalls(calls)[0]) ?? {}
    assert.equal(body.geoOverride, false)
    assert.equal('latitude' in body, false, 'ZIA re-derives the location; a pinned one would not be a revert')
    assert.equal('longitude' in body, false)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-static-ips rollback: deletes a static IP deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/staticIP\/8801$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-static-ips rollback: undoes the newest change first', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({}), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, CREATED_ENTRY] }))

    assert.deepEqual(
      resourceCalls(calls).map((c) => c.method),
      ['DELETE', 'PUT'],
      'the later entry is reverted before the earlier one',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-static-ips rollback: a static IP already gone is not an error', async () => {
  // 404 is a known answer — the object we would delete is already absent, which
  // is the state rollback was trying to reach.
  const { restore } = recordFetch([TOKEN, notFound(), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back and activated 1/)
  } finally {
    restore()
  }
})

test('zia-static-ips rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Invalid static IP address')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Invalid static IP address/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-static-ips rollback: a failed activation is reported as still-staged', async () => {
  const { restore } = recordFetch([TOKEN, ok({}), ziaError(409, 'Another activation is already in progress')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /Re-run rollback/)
  } finally {
    restore()
  }
})
