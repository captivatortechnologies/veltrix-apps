// deploy for zia-network-app-groups.
//
// What is specific to this type:
//   * membership is a list of PREDEFINED ZIA network-application ids (APNS,
//     WEBEX, …) authored one per line — the group is nothing but that list, and
//     a deploy rewrites it wholesale;
//   * description is always sent, even blank, so clearing it converges;
//   * ZIA stages writes, so a deploy that never reaches /status/activate has
//     changed nothing the customer can see.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACTIVATED,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  ok,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const GROUP = item('Collab apps', {
  name: 'Collab apps',
  description: 'desired description',
  network_applications: 'APNS\nWEBEX\nZOOM',
})

/**
 * The live group, deliberately UNLIKE the canvas: a different description and a
 * different membership. A rollback entry that mirrors the canvas rather than
 * this has recorded the desired state, not the prior one.
 */
const LIVE = {
  id: 6611,
  name: 'Collab apps',
  description: 'live description set by hand',
  networkApplications: ['SKYPE', 'SLACK'],
}

registerDeployGuardContract({ label: 'zia-network-app-groups', handler: deploy, product: 'zia', items: [GROUP] })

test('zia-network-app-groups deploy: creates a group that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 6600, name: 'Something Else' }]),
    created({ id: 6612, name: 'Collab apps' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/networkApplicationGroups\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/networkApplicationGroups$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Collab apps')
    assert.equal(body?.description, 'desired description')
    assert.deepEqual(body?.networkApplications, ['APNS', 'WEBEX', 'ZOOM'], 'authored order is sent as authored')

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Collab apps', existed: false, id: 6612 }])
    assert.deepEqual(rollback.createdIds, [6612])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-network-app-groups deploy: updates an existing group and records its LIVE prior membership', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), ok({ id: 6611 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a group that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/networkApplicationGroups\/6611$/)
    assert.deepEqual(bodyOf(tenant[1])?.networkApplications, ['APNS', 'WEBEX', 'ZOOM'])

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 6611)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.deepEqual(entry.prior.networkApplications, ['SKYPE', 'SLACK'])
  } finally {
    restore()
  }
})

test('zia-network-app-groups deploy: sends a blank description so clearing it converges', async () => {
  const noDescription = item('Collab apps', { name: 'Collab apps', network_applications: 'APNS' })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 6612 }), ACTIVATED])
  try {
    await deploy(deployContext([noDescription]))

    assert.equal(bodyOf(assertAuthenticatedFirst(assert, calls)[1])?.description, '')
  } finally {
    restore()
  }
})

test('zia-network-app-groups deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Unknown network application id ZOOM'),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Unknown network application id ZOOM/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live group, so the prior membership deploy
    // read beforehand has to survive on the failure path or it can never be
    // restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: Record<string, unknown> }> }
    assert.equal(rollback.previousState.length, 1)
    assert.deepEqual(rollback.previousState[0].prior?.networkApplications, ['SKYPE', 'SLACK'])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-network-app-groups deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/networkApplicationGroups/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list network application groups/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-network-app-groups deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 6612 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [6612], 'the staged group still exists and must be revertible')
  } finally {
    restore()
  }
})

test('zia-network-app-groups deploy: a create whose response carries no id fails the deploy', async () => {
  // NOTE: what this path RECORDS is deliberately not asserted. The POST
  // succeeded — the group exists in the tenant — but deploy throws on the
  // missing id BEFORE pushing its rollback entry, so the created group is
  // returned as nothing to roll back. Asserting that would bless it; see the
  // report accompanying these tests.
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ name: 'Collab apps' })])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/)
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})
