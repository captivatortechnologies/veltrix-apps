// rollback for zpa-servers.
//
// The shared contract covers the refusals and the two entries that must produce
// no call at all. What is specific here: ZPA has no activation step, the restore
// PUT is replace-style (so the id is echoed) and must carry the prior ADDRESS
// back, and a server already deleted (404) is the state rollback was aiming at.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  resourceCalls,
  rollbackContext,
  zpaError,
} from '../../../lib/__tests__/fakeZscaler'
import { registerRollbackGuardContract } from '../../../lib/__tests__/zscalerContracts'

registerRollbackGuardContract({
  label: 'zpa-servers',
  handler: rollback,
  product: 'zpa',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'web-01',
  existed: true,
  id: '216196257331370400',
  prior: {
    name: 'web-01',
    description: 'live description set by hand',
    address: '10.20.30.40',
    enabled: false,
  },
}

const CREATED_ENTRY = { name: 'web-02', existed: false, id: '216196257331370999' }

test('zpa-servers rollback: restores the prior body of a server deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.ok(tenant[0].url.includes('/server/216196257331370400'), `restore hit ${tenant[0].url}`)

    const body = bodyOf(tenant[0])
    assert.equal(body?.id, '216196257331370400', 'the replace-style PUT must echo the id back')
    assert.equal(body?.description, 'live description set by hand')
    assert.equal(body?.address, '10.20.30.40', 'the recorded prior address, not a default')
    assert.equal(body?.enabled, false)

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-servers rollback: deletes a server deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.ok(tenant[0].url.includes('/server/216196257331370999'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-servers rollback: undoes the newest change first', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({})])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, CREATED_ENTRY] }))

    assert.deepEqual(
      resourceCalls(calls).map((c) => c.method),
      ['DELETE', 'PUT'],
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-servers rollback: a server already gone is not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back 1/)
  } finally {
    restore()
  }
})

test('zpa-servers rollback: a server still in a server group cannot be deleted, and that is reported', async () => {
  // ZPA refuses to delete a server a server group still routes to. That has to
  // surface as a message an operator can act on, not a crash.
  const { restore } = recordFetch([TOKEN, zpaError(400, 'server is still a member of a server group')])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /still a member of a server group/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
