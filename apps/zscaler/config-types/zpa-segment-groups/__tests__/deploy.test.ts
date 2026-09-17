// deploy for zpa-segment-groups — the reference for every ZPA config type here.
//
// What separates ZPA from ZIA and is worth driving end to end:
//   * every path embeds the ZPA customer id, which is NOT in the token — it is
//     an app setting, and without it the handler must refuse before calling;
//   * changes apply IMMEDIATELY, so there is no activation step and a successful
//     write is the end of the operation;
//   * the PUT is replace-style, so the id has to be echoed in the body;
//   * the update path must record the LIVE prior body, not the canvas.

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

const GROUP = item('Corp Apps', {
  name: 'Corp Apps',
  description: 'desired description',
  enabled: true,
})

/** The live group, deliberately UNLIKE the canvas in description and enabled. */
const LIVE = {
  id: '216196257331370400',
  name: 'Corp Apps',
  description: 'live description set by hand',
  enabled: false,
}

registerDeployGuardContract({ label: 'zpa-segment-groups', handler: deploy, product: 'zpa', items: [GROUP] })

test('zpa-segment-groups deploy: creates a group that does not exist, addressing the ZPA customer', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList([{ id: '1', name: 'Something Else' }]),
    created({ id: '216196257331370999', name: 'Corp Apps' }),
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.ok(
      tenant[0].url.includes(`/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/segmentGroup`),
      `listing hit ${tenant[0].url}`,
    )
    assert.equal(tenant[1].method, 'POST')

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Corp Apps')
    assert.equal(body?.description, 'desired description')
    assert.equal(body?.enabled, true)
    assert.equal(body?.id, undefined, 'a create must not carry an id')

    assert.equal(result.success, true)
    assert.equal(
      calls.filter((c) => c.url.includes('/status/activate')).length,
      0,
      'ZPA applies immediately — there is nothing to activate',
    )

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: string[] }
    assert.deepEqual(rollback.previousState, [
      { name: 'Corp Apps', existed: false, id: '216196257331370999' },
    ])
    assert.deepEqual(rollback.createdIds, ['216196257331370999'])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-segment-groups deploy: updates an existing group and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([LIVE]), created({ id: LIVE.id })])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a group that exists is updated, not created')
    assert.ok(tenant[1].url.includes(`/segmentGroup/${LIVE.id}`), `update hit ${tenant[1].url}`)

    const body = bodyOf(tenant[1])
    assert.equal(body?.id, LIVE.id, 'the replace-style PUT must echo the id back')
    assert.equal(body?.enabled, true)

    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: string; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, LIVE.id)
    assert.equal(entry.prior.description, 'live description set by hand', 'rollback must restore what was there')
    assert.equal(entry.prior.enabled, false)
  } finally {
    restore()
  }
})

test('zpa-segment-groups deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([LIVE]), zpaError(400, 'segment group name already in use')])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /segment group name already in use/)
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { description?: string } }> }
    assert.equal(
      rollback.previousState[0].prior?.description,
      'live description set by hand',
      'the prior body read before the overwrite must survive the failure path',
    )
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-segment-groups deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/segmentGroup/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list segment groups/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
  } finally {
    restore()
  }
})
