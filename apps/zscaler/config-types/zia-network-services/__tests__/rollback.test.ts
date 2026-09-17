// rollback for zia-network-services.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: the restore body
// must carry the prior PORT RANGES deploy captured, not the canvas's; the prior
// `type` is restored rather than assumed CUSTOM; a service deploy created is
// deleted; a service already gone (404) is not an error; and the revert is itself
// a staged ZIA change, so it only takes effect on activation.

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
  label: 'zia-network-services',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'Vendor SFTP',
  existed: true,
  id: 7001,
  prior: {
    name: 'Vendor SFTP',
    description: 'live description set by hand',
    type: 'CUSTOM',
    destTcpPorts: [{ start: 21, end: 21 }],
    destUdpPorts: [{ start: 69, end: 69 }],
  },
}

const CREATED_ENTRY = { name: 'New Service', existed: false, id: 7009 }

test('zia-network-services rollback: restores the prior ports of a service deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 7001 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/networkServices\/7001$/)
    const body = bodyOf(tenant[0])
    assert.equal(body?.description, 'live description set by hand')
    assert.equal(body?.type, 'CUSTOM')
    assert.deepEqual(body?.destTcpPorts, [{ start: 21, end: 21 }])
    assert.deepEqual(body?.destUdpPorts, [{ start: 69, end: 69 }])

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-network-services rollback: deletes a service deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/networkServices\/7009$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-network-services rollback: undoes the newest change first', async () => {
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

test('zia-network-services rollback: a service already gone is not an error', async () => {
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

test('zia-network-services rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Network service is referenced by a firewall rule')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /referenced by a firewall rule/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-network-services rollback: a failed activation is reported as still-staged', async () => {
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
