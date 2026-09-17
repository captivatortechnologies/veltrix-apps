// deploy for zia-admin-roles.
//
// What is specific to this type and worth driving end to end:
//   * identity is `name` and the id is NUMERIC;
//   * the payload is the parsed `role_json` permissions map with name and rank
//     layered ON TOP, so a role_json that also carries a name cannot rename;
//   * a BUILT-IN role (`isNameL10nTag: true`) must never be overwritten;
//   * `/adminRoles` is read through a two-step lister (paged, then a direct GET
//     when the paged read yields nothing), so an empty tenant costs two reads;
//   * ZIA stages writes, so a deploy that never reaches `/status/activate` has
//     changed nothing the customer can see.
//
// NOT asserted, deliberately: the path where the POST succeeds but the response
// carries no id. deploy throws there BEFORE pushing the rollback entry, so the
// role exists in the tenant with nothing recorded — see the report.

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
  writeCalls,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const ROLE = item('SOC Analyst', {
  name: 'SOC Analyst',
  rank: 3,
  role_json: '{"policyAccess":"READ_WRITE","dashboardAccess":"READ_ONLY"}',
})

/**
 * The live role, deliberately UNLIKE the canvas: a lower rank and weaker
 * permissions. A rollback entry mirroring the canvas rather than this has
 * recorded the desired state, not the prior state.
 */
const LIVE = {
  id: 4102,
  name: 'SOC Analyst',
  rank: 6,
  isNameL10nTag: false,
  policyAccess: 'READ_ONLY',
  dashboardAccess: 'NONE',
  adminAcctAccess: 'READ_ONLY',
}

const OTHER_ROLE = { id: 9001, name: 'Super Admin', rank: 1, isNameL10nTag: true }

registerDeployGuardContract({ label: 'zia-admin-roles', handler: deploy, product: 'zia', items: [ROLE] })

test('zia-admin-roles deploy: creates a role that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([OTHER_ROLE]),
    created({ id: 4110, name: 'SOC Analyst', rank: 3 }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([ROLE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/adminRoles\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/adminRoles$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'SOC Analyst')
    assert.equal(body?.rank, 3)
    assert.equal(body?.policyAccess, 'READ_WRITE')
    assert.equal(body?.dashboardAccess, 'READ_ONLY')

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'SOC Analyst', existed: false, id: 4110 }])
    assert.deepEqual(rollback.createdIds, [4110])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-admin-roles deploy: updates an existing role and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), ok({ id: 4102 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([ROLE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a role that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/adminRoles\/4102$/)
    assert.equal(bodyOf(tenant[1])?.rank, 3)
    assert.equal(bodyOf(tenant[1])?.policyAccess, 'READ_WRITE')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 4102)
    assert.equal(entry.prior.rank, 6, 'rollback must restore the rank that was there')
    assert.equal(entry.prior.policyAccess, 'READ_ONLY')
    assert.equal(entry.prior.adminAcctAccess, 'READ_ONLY')
  } finally {
    restore()
  }
})

test('zia-admin-roles deploy: refuses to overwrite a built-in role, and writes nothing', async () => {
  const builtIn = { id: 3, name: 'SOC Analyst', rank: 1, isNameL10nTag: true }
  const { calls, restore } = recordFetch([TOKEN, ziaList([builtIn])])
  try {
    const result = await deploy(deployContext([ROLE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /built-in admin role/)
    assert.equal(writeCalls(calls).length, 0, 'a built-in role must never be written to')
    const rollback = result.rollbackData as { previousState: unknown[] }
    assert.deepEqual(rollback.previousState, [], 'a built-in role is never captured for rollback')
  } finally {
    restore()
  }
})

test('zia-admin-roles deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Rank must be between 1 and 7'),
  ])
  try {
    const result = await deploy(deployContext([ROLE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rank must be between 1 and 7/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live role, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { rank?: number } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.rank, 6)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-admin-roles deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/adminRoles/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([ROLE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list admin roles/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-admin-roles deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([OTHER_ROLE]),
    created({ id: 4110 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([ROLE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [4110], 'the staged role still exists and must be revertible')
  } finally {
    restore()
  }
})
