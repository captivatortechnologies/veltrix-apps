// rollback for zia-forwarding-control-rules.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: the forwarding
// targets (zpaGateway, zpaAppSegments, proxyGateway) live in the captured body,
// so the restore has to PUT that body back verbatim — restoring only the scalars
// would leave the rule pointing wherever the deploy sent it. A rule deploy
// created is deleted, a rule already gone (404) is not an error, and the revert
// only takes effect on activation.

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
  resourceWrites,
  rollbackContext,
  ziaError,
} from '../../../lib/__tests__/fakeZscaler'
import { registerRollbackGuardContract } from '../../../lib/__tests__/zscalerContracts'

registerRollbackGuardContract({
  label: 'zia-forwarding-control-rules',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'Route Branch To ZPA',
  existed: true,
  id: 907,
  prior: {
    id: 907,
    name: 'Route Branch To ZPA',
    order: 2,
    state: 'ENABLED',
    type: 'FORWARDING',
    forwardMethod: 'DIRECT',
    srcIps: ['192.168.0.0/16'],
    zpaGateway: { id: 599, name: 'Hand-made legacy gateway' },
  },
}

const CREATED_ENTRY = { name: 'New Forwarding Rule', existed: false, id: 9001 }

test('zia-forwarding-control-rules rollback: restores the recorded prior body, not a default', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 907 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/forwardingRules\/907$/)
    const body = bodyOf(tenant[0])
    assert.equal(body?.forwardMethod, 'DIRECT')
    assert.equal(body?.state, 'ENABLED')
    assert.equal(body?.order, 2)
    assert.deepEqual(body?.srcIps, ['192.168.0.0/16'])
    assert.deepEqual(body?.zpaGateway, { id: 599, name: 'Hand-made legacy gateway' })

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules rollback: deletes a rule deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/forwardingRules\/9001$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules rollback: never writes over a predefined rule', async () => {
  // Deploy refuses predefined names, so this entry cannot arise from a normal
  // deploy — but a hand-edited or migrated rollback record must still not push a
  // body at one of ZIA's built-in forwarding rules.
  const { calls, restore } = recordFetch([TOKEN, ACTIVATED])
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'ZPA Pool For Stray Traffic',
            existed: true,
            id: 3,
            prior: { id: 3, name: 'ZPA Pool For Stray Traffic', forwardMethod: 'ZPA' },
          },
        ],
      }),
    )

    assert.equal(
      resourceWrites(calls).length,
      0,
      `expected no resource write, got ${resourceWrites(calls)
        .map((c) => `${c.method} ${c.url}`)
        .join(', ')}`,
    )
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules rollback: undoes the newest change first, and activates once', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({}), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, CREATED_ENTRY] }))

    assert.deepEqual(
      resourceCalls(calls).map((c) => c.method),
      ['DELETE', 'PUT'],
      'the later entry is reverted before the earlier one',
    )
    assert.equal(activateCalls(calls).length, 1, 'one activation commits the whole revert')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules rollback: a rule already gone is not an error', async () => {
  // 404 is a known answer — the rule we would delete is already absent, which is
  // the state rollback was trying to reach.
  const { restore } = recordFetch([TOKEN, notFound(), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back and activated 1/)
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Referenced ZPA gateway no longer exists')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Referenced ZPA gateway no longer exists/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules rollback: a failed activation is reported as still-staged', async () => {
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
