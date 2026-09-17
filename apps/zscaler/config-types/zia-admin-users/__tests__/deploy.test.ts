// deploy for zia-admin-users.
//
// What is specific to this type and worth driving end to end:
//   * identity is `loginName`, and each account references its role by NAME — so
//     deploy reads /adminRoles FIRST to resolve the name to an id, and a role
//     the tenant does not have must fail the deploy rather than invent an id;
//   * the PASSWORD is write-only: it is sent on the CREATE and must appear
//     nowhere else — not in the update body, not in rollbackData, not in the
//     result;
//   * the update path must record the LIVE prior account (its own role id
//     included), which is the only thing rollback can restore;
//   * ZIA stages writes, so a deploy that never reaches `/status/activate` has
//     changed nothing the customer can see.
//
// NOT asserted, deliberately: the path where the POST succeeds but the response
// carries no id. deploy throws there BEFORE pushing the rollback entry, so the
// admin account exists in the tenant with nothing recorded — see the report.

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

/** Distinctive on purpose: anything but the create body carrying it is a leak. */
const PASSWORD = 'zia-admin-password-MUST-NOT-LEAK'

const USER = item('SOC Analyst account', {
  login_name: 'soc.analyst@acme.com',
  user_name: 'SOC Analyst',
  email: 'soc.analyst@acme.com',
  role_name: 'SOC Analyst',
  comments: 'Managed by Veltrix',
  disabled: false,
  password: PASSWORD,
})

const ROLES = ziaList([
  { id: 7, name: 'SOC Analyst' },
  { id: 9, name: 'Super Admin' },
])

/**
 * The live account, deliberately UNLIKE the canvas: a different display name,
 * email, role and disabled flag. A rollback entry mirroring the canvas rather
 * than this has recorded the desired state, not the prior state.
 */
const LIVE = {
  id: 5501,
  loginName: 'soc.analyst@acme.com',
  userName: 'Former Analyst',
  email: 'former.analyst@acme.com',
  role: { id: 9, name: 'Super Admin' },
  comments: 'granted by hand in the ZIA console',
  disabled: true,
}

registerDeployGuardContract({ label: 'zia-admin-users', handler: deploy, product: 'zia', items: [USER] })

test('zia-admin-users deploy: creates an account that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ROLES,
    ziaList([{ id: 1, loginName: 'admin@acme.com' }]),
    created({ id: 5510, loginName: 'soc.analyst@acme.com' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([USER]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.match(tenant[0].url, /\/zia\/api\/v1\/adminRoles\?/, 'role names are resolved to ids first')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/adminUsers\?/)
    assert.equal(tenant[2].method, 'POST')
    assert.match(tenant[2].url, /\/zia\/api\/v1\/adminUsers$/)

    const body = bodyOf(tenant[2])
    assert.equal(body?.loginName, 'soc.analyst@acme.com')
    assert.equal(body?.userName, 'SOC Analyst')
    assert.equal(body?.email, 'soc.analyst@acme.com')
    assert.deepEqual(body?.role, { id: 7 }, 'the role NAME is resolved to the live role id')
    assert.equal(body?.comments, 'Managed by Veltrix')
    assert.equal(body?.disabled, false)
    assert.equal(body?.password, PASSWORD, 'a create is the one place the password is sent')

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [
      { loginName: 'soc.analyst@acme.com', existed: false, id: 5510 },
    ])
    assert.deepEqual(rollback.createdIds, [5510])
    assert.equal(leaksSecret(result), false)
    assert.equal(
      JSON.stringify(result).includes(PASSWORD),
      false,
      'the write-only password must never be persisted into a deploy result',
    )
  } finally {
    restore()
  }
})

test('zia-admin-users deploy: updates an existing account, without the password, recording its LIVE prior state', async () => {
  const { calls, restore } = recordFetch([TOKEN, ROLES, ziaList([LIVE]), ok({ id: 5501 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([USER]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[2].method, 'PUT', 'an account that exists is updated, not created')
    assert.match(tenant[2].url, /\/zia\/api\/v1\/adminUsers\/5501$/)

    const body = bodyOf(tenant[2])
    assert.equal(body?.userName, 'SOC Analyst')
    assert.deepEqual(body?.role, { id: 7 })
    assert.equal(body?.disabled, false)
    assert.equal(body?.password, undefined, 'an update must never resend the write-only password')
    assert.equal(tenant[2].body.includes(PASSWORD), false)

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 5501)
    assert.equal(entry.prior.userName, 'Former Analyst', 'rollback must restore what was there')
    assert.equal(entry.prior.email, 'former.analyst@acme.com')
    assert.equal(entry.prior.roleId, 9)
    assert.equal(entry.prior.comments, 'granted by hand in the ZIA console')
    assert.equal(entry.prior.disabled, true)
    assert.equal(JSON.stringify(result).includes(PASSWORD), false)
  } finally {
    restore()
  }
})

test('zia-admin-users deploy: refuses an account whose role does not exist in the tenant', async () => {
  // Resolving the role name to an id is the one thing deploy cannot guess. An
  // account created against the wrong role id is a silent privilege change.
  const { calls, restore } = recordFetch([TOKEN, ziaList([{ id: 9, name: 'Super Admin' }]), ziaList([])])
  try {
    const result = await deploy(deployContext([USER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /references role "SOC Analyst", which does not exist in the tenant/)
    assert.equal(resourceWrites(calls).length, 0, 'no account may be written against a guessed role')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-admin-users deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ROLES,
    ziaList([LIVE]),
    ziaError(400, 'Email address is already in use by another admin'),
  ])
  try {
    const result = await deploy(deployContext([USER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Email address is already in use/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live account, so the prior state deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { roleId?: number } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.roleId, 9)
    assert.equal(leaksSecret(result), false)
    assert.equal(JSON.stringify(result).includes(PASSWORD), false)
  } finally {
    restore()
  }
})

test('zia-admin-users deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/adminUsers/, respond: serverError() },
    { url: /\/adminRoles/, respond: ROLES },
  ])
  try {
    const result = await deploy(deployContext([USER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list admin users/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-admin-users deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ROLES,
    ziaList([]),
    created({ id: 5510 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([USER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [5510], 'the staged account still exists and must be revertible')
  } finally {
    restore()
  }
})
