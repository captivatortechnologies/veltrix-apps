// rollback for zpa-service-edge-groups.
//
// The shared contract covers the refusals and the two entries that must produce
// no call at all. What is specific here: the restore PUT is replace-style, so it
// has to carry the group's whole prior record back — geography AND upgrade
// window — and a group already deleted (404) is the state rollback was aiming at.

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
  label: 'zpa-service-edge-groups',
  handler: rollback,
  product: 'zpa',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'San Jose Edges',
  existed: true,
  id: '216196257331370400',
  prior: {
    name: 'San Jose Edges',
    description: 'live description set by hand',
    enabled: false,
    location: 'Santa Clara, CA, USA',
    latitude: '37.3541',
    longitude: '-121.9552',
    countryCode: 'CA',
    versionProfileId: '1',
    upgradeDay: 'WEDNESDAY',
    upgradeTimeInSecs: '7200',
  },
}

const CREATED_ENTRY = { name: 'Frankfurt Edges', existed: false, id: '216196257331370999' }

test('zpa-service-edge-groups rollback: restores the prior body, geography and upgrade window included', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.ok(tenant[0].url.includes('/serviceEdgeGroup/216196257331370400'), `restore hit ${tenant[0].url}`)

    const body = bodyOf(tenant[0])
    assert.equal(body?.id, '216196257331370400', 'the replace-style PUT must echo the id back')
    assert.equal(body?.description, 'live description set by hand')
    assert.equal(body?.enabled, false)
    assert.equal(body?.location, 'Santa Clara, CA, USA')
    assert.equal(body?.latitude, '37.3541')
    assert.equal(body?.longitude, '-121.9552')
    assert.equal(body?.countryCode, 'CA')
    assert.equal(body?.versionProfileId, '1', 'the recorded prior profile, not the "0" default')
    assert.equal(body?.upgradeDay, 'WEDNESDAY', 'the recorded prior window, not the SUNDAY default')
    assert.equal(body?.upgradeTimeInSecs, '7200')

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups rollback: deletes a group deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.ok(tenant[0].url.includes('/serviceEdgeGroup/216196257331370999'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups rollback: undoes the newest change first', async () => {
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

test('zpa-service-edge-groups rollback: a group already gone is not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back 1/)
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups rollback: a group with service edges bound to it cannot be deleted, and that is reported', async () => {
  // ZPA refuses to delete a service edge group that still has Private Service
  // Edges or provisioning keys in it. That has to surface as a message an
  // operator can act on, not a crash.
  const { restore } = recordFetch([
    TOKEN,
    zpaError(400, 'service edge group still has private service edges assigned'),
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /private service edges assigned/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
