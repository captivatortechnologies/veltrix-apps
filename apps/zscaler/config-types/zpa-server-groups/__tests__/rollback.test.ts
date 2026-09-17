// rollback for zpa-server-groups.
//
// The shared contract covers the refusals and the two entries that must produce
// no call at all. What is specific here: the restore body has to carry the prior
// MEMBERSHIP back (connector group ids, and servers only when the prior record
// had discovery off), the PUT is replace-style so the id is echoed, and a group
// already deleted (404) is the state rollback was aiming at, not a failure.

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
  label: 'zpa-server-groups',
  handler: rollback,
  product: 'zpa',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'Prod Web Tier',
  existed: true,
  id: '216196257331370400',
  prior: {
    name: 'Prod Web Tier',
    description: 'live description set by hand',
    enabled: false,
    dynamicDiscovery: false,
    appConnectorGroups: [{ id: '216196257331370599' }],
    servers: [{ id: '216196257331370699' }],
  },
}

const DISCOVERY_ENTRY = {
  name: 'Discovered Tier',
  existed: true,
  id: '216196257331370401',
  prior: {
    name: 'Discovered Tier',
    description: '',
    enabled: true,
    dynamicDiscovery: true,
    appConnectorGroups: [{ id: '216196257331370599' }],
    servers: [],
  },
}

const CREATED_ENTRY = { name: 'New Tier', existed: false, id: '216196257331370999' }

test('zpa-server-groups rollback: restores the prior body, membership included', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.ok(tenant[0].url.includes('/serverGroup/216196257331370400'), `restore hit ${tenant[0].url}`)

    const body = bodyOf(tenant[0])
    assert.equal(body?.id, '216196257331370400', 'the replace-style PUT must echo the id back')
    assert.equal(body?.description, 'live description set by hand')
    assert.equal(body?.enabled, false)
    assert.equal(body?.dynamicDiscovery, false)
    assert.deepEqual(body?.appConnectorGroups, [{ id: '216196257331370599' }])
    assert.deepEqual(body?.servers, [{ id: '216196257331370699' }])

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-server-groups rollback: omits servers when the prior record discovered its own', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ previousState: [DISCOVERY_ENTRY] }))

    const body = bodyOf(assertAuthenticatedFirst(assert, calls)[0])
    assert.equal(body?.dynamicDiscovery, true)
    assert.equal(body?.servers, undefined, 'ZPA rejects explicit servers when discovery is on')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-server-groups rollback: deletes a group deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.ok(tenant[0].url.includes('/serverGroup/216196257331370999'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-server-groups rollback: undoes the newest change first', async () => {
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

test('zpa-server-groups rollback: a group already gone is not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back 1/)
  } finally {
    restore()
  }
})

test('zpa-server-groups rollback: a group still referenced cannot be deleted, and that is reported', async () => {
  // ZPA refuses to delete a server group an application segment still points at.
  // That has to surface as a message an operator can act on, not a crash.
  const { restore } = recordFetch([TOKEN, zpaError(400, 'server group is referenced by an application segment')])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /referenced by an application segment/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
