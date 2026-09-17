// rollback for zpa-application-segments.
//
// The shared contract covers the refusals and the two entries that must produce
// no call at all. Specific here: the restore PUT has to put the segment's
// DEPENDENCY ids back (segmentGroupId + serverGroups) alongside the domains and
// port ranges — a restore that dropped them would leave an application segment
// with no backing servers — and ZPA refuses to delete a segment mid-session.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  NO_CONTENT,
  TOKEN,
  ZPA_CUSTOMER_ID,
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
  label: 'zpa-application-segments',
  handler: rollback,
  product: 'zpa',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'Corp Intranet',
  existed: true,
  id: '216196257331370500',
  prior: {
    name: 'Corp Intranet',
    description: 'live description set by hand',
    enabled: false,
    domainNames: ['legacy.corp.example'],
    segmentGroupId: 'sg-legacy',
    serverGroups: [{ id: 'srv-legacy' }],
    tcpPortRange: [{ from: '80', to: '80' }],
    udpPortRange: [],
    bypassType: 'ALWAYS',
    healthReporting: 'NONE',
  },
}

const CREATED_ENTRY = { name: 'New Segment', existed: false, id: '216196257331370999' }

test('zpa-application-segments rollback: restores the prior body of a segment deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.ok(
      tenant[0].url.includes(
        `/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/application/216196257331370500`,
      ),
      `restore hit ${tenant[0].url}`,
    )

    const body = bodyOf(tenant[0])
    assert.equal(body?.id, '216196257331370500', 'the replace-style PUT must echo the id back')
    assert.equal(body?.description, 'live description set by hand')
    assert.equal(body?.enabled, false)
    assert.deepEqual(body?.domainNames, ['legacy.corp.example'])
    assert.equal(body?.segmentGroupId, 'sg-legacy', 'the recorded prior group, not a default')
    assert.deepEqual(body?.serverGroups, [{ id: 'srv-legacy' }])
    assert.deepEqual(body?.tcpPortRange, [{ from: '80', to: '80' }])
    assert.deepEqual(body?.udpPortRange, [])
    assert.equal(body?.bypassType, 'ALWAYS')
    assert.equal(body?.healthReporting, 'NONE')

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-application-segments rollback: deletes a segment deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.ok(tenant[0].url.includes('/application/216196257331370999'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-application-segments rollback: undoes the newest change first', async () => {
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

test('zpa-application-segments rollback: a segment already gone is not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back 1/)
  } finally {
    restore()
  }
})

test('zpa-application-segments rollback: a segment ZPA refuses to delete is reported, not thrown', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaError(400, 'application segment has active sessions and cannot be deleted'),
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /active sessions and cannot be deleted/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
