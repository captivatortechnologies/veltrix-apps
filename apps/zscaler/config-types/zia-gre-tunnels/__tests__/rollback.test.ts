// rollback for zia-gre-tunnels.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body) — note it is registered with
// `nameKey: 'sourceIp'`, because a GRE tunnel's identity in the rollback record
// is its source IP, not a name. What is specific here: the restore body must
// replay the VIP objects and flags deploy captured, not a default set of them;
// a tunnel deploy created is deleted; a tunnel already gone (404) is not an
// error; and the revert is itself a staged ZIA change.

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
  label: 'zia-gre-tunnels',
  handler: rollback,
  product: 'zia',
  nameKey: 'sourceIp',
})

const UPDATED_ENTRY = {
  sourceIp: '203.0.113.10',
  existed: true,
  id: 4411,
  prior: {
    sourceIp: '203.0.113.10',
    comment: 'live comment set by hand',
    primaryDestVip: { id: 99999, virtualIp: '165.225.1.1' },
    secondaryDestVip: { id: 88888, virtualIp: '165.225.2.2' },
    withinCountry: false,
    ipUnnumbered: true,
  },
}

const CREATED_ENTRY = { sourceIp: '198.51.100.7', existed: false, id: 4412 }

test('zia-gre-tunnels rollback: restores the prior VIPs and flags of a tunnel deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 4411 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/greTunnels\/4411$/)
    const body = bodyOf(tenant[0])
    assert.equal(body?.sourceIp, '203.0.113.10')
    assert.equal(body?.comment, 'live comment set by hand')
    assert.deepEqual(body?.primaryDestVip, { id: 99999, virtualIp: '165.225.1.1' })
    assert.deepEqual(body?.secondaryDestVip, { id: 88888, virtualIp: '165.225.2.2' })
    assert.equal(body?.withinCountry, false)
    assert.equal(body?.ipUnnumbered, true)

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-gre-tunnels rollback: deletes a tunnel deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/greTunnels\/4412$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-gre-tunnels rollback: undoes the newest change first', async () => {
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

test('zia-gre-tunnels rollback: a tunnel already gone is not an error', async () => {
  // 404 is a known answer — the tunnel we would delete is already absent, which
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

test('zia-gre-tunnels rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'GRE tunnel destination VIP is not reachable')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /GRE tunnel destination VIP is not reachable/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-gre-tunnels rollback: a failed activation is reported as still-staged', async () => {
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
