// deploy for zpa-servers.
//
// A ZPA server is the leaf of the ZPA object graph — one listing, one write, no
// references to resolve — so what this drives is the ZPA rules themselves:
//   * every path embeds the ZPA customer id, which is NOT in the token;
//   * changes apply IMMEDIATELY, so there is no activation step;
//   * the PUT is replace-style, so the id has to be echoed in the body;
//   * the update path must record the LIVE prior body (address included — an
//     address restored from the canvas instead of the tenant would point the
//     server group at the wrong host).

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  TOKEN,
  ZPA_CUSTOMER_ID,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  zpaError,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const SERVER = item('web-01', {
  name: 'web-01',
  description: 'desired description',
  address: 'web-01.corp.example.com',
  enabled: true,
})

/** The live server, deliberately UNLIKE the canvas in description, address and state. */
const LIVE = {
  id: '216196257331370400',
  name: 'web-01',
  description: 'live description set by hand',
  address: '10.20.30.40',
  enabled: false,
}

registerDeployGuardContract({ label: 'zpa-servers', handler: deploy, product: 'zpa', items: [SERVER] })

test('zpa-servers deploy: creates a server that does not exist, addressing the ZPA customer', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList([{ id: '1', name: 'db-01' }]),
    created({ id: '216196257331370999', name: 'web-01' }),
  ])
  try {
    const result = await deploy(deployContext([SERVER]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant.length, 2, 'one listing, then one write')
    assert.equal(tenant[0].method, 'GET')
    assert.ok(
      tenant[0].url.includes(`/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/server`),
      `listing hit ${tenant[0].url}`,
    )
    assert.equal(tenant[1].method, 'POST')

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'web-01')
    assert.equal(body?.description, 'desired description')
    assert.equal(body?.address, 'web-01.corp.example.com')
    assert.equal(body?.enabled, true)
    assert.equal(body?.id, undefined, 'a create must not carry an id')

    assert.equal(result.success, true)
    assert.equal(
      calls.filter((c) => c.url.includes('/status/activate')).length,
      0,
      'ZPA applies immediately — there is nothing to activate',
    )

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: string[] }
    assert.deepEqual(rollback.previousState, [{ name: 'web-01', existed: false, id: '216196257331370999' }])
    assert.deepEqual(rollback.createdIds, ['216196257331370999'])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-servers deploy: updates an existing server and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([LIVE]), created({ id: LIVE.id })])
  try {
    const result = await deploy(deployContext([SERVER]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a server that exists is updated, not created')
    assert.ok(tenant[1].url.includes(`/server/${LIVE.id}`), `update hit ${tenant[1].url}`)

    const body = bodyOf(tenant[1])
    assert.equal(body?.id, LIVE.id, 'the replace-style PUT must echo the id back')
    assert.equal(body?.address, 'web-01.corp.example.com')
    assert.equal(body?.enabled, true)

    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: string; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, LIVE.id)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.equal(entry.prior.address, '10.20.30.40', 'the prior address is the LIVE one, not the deployed one')
    assert.equal(entry.prior.enabled, false)
  } finally {
    restore()
  }
})

test('zpa-servers deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([LIVE]), zpaError(400, 'server address is not a valid FQDN or IP')])
  try {
    const result = await deploy(deployContext([SERVER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /not a valid FQDN or IP/)
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { address?: string } }> }
    assert.equal(
      rollback.previousState[0].prior?.address,
      '10.20.30.40',
      'the prior body read before the overwrite must survive the failure path',
    )
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-servers deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/server/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([SERVER]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list servers/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
  } finally {
    restore()
  }
})

test('zpa-servers deploy: deploys every declared server, and stops at the first the vendor rejects', async () => {
  const SECOND = item('web-02', { name: 'web-02', address: 'web-02.corp.example.com', enabled: true })
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList([]),
    created({ id: '216196257331370901', name: 'web-01' }),
    zpaError(400, 'server name already in use'),
  ])
  try {
    const result = await deploy(deployContext([SERVER, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /failed after 1 of 2 server\(s\)/)
    const rollback = result.rollbackData as { createdIds: string[] }
    assert.deepEqual(
      rollback.createdIds,
      ['216196257331370901'],
      'the server that WAS created must still be recorded, or rollback leaves it behind',
    )
    assert.equal(resourceWrites(calls).length, 2)
  } finally {
    restore()
  }
})
