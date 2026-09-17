// rollback for zpa-app-connector-groups.
//
// The shared contract covers the refusals and the two entries that must produce
// no call at all. Specific here: the restore PUT has to put every geo/connector
// field back (a default would silently move a customer's connector group to
// "0,0"), and ZPA refuses to delete a group a server group still points at.

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
  label: 'zpa-app-connector-groups',
  handler: rollback,
  product: 'zpa',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'San Jose Connectors',
  existed: true,
  id: '216196257331370400',
  prior: {
    name: 'San Jose Connectors',
    description: 'live description set by hand',
    enabled: false,
    location: 'Frankfurt, DE',
    latitude: '50.1109',
    longitude: '8.6821',
    countryCode: 'DE',
    dnsQueryType: 'IPV6',
    versionProfileId: '0',
    cityCountry: 'Frankfurt, DE',
  },
}

const CREATED_ENTRY = { name: 'New Connectors', existed: false, id: '216196257331370999' }

test('zpa-app-connector-groups rollback: restores the prior body of a group deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.ok(
      tenant[0].url.includes(
        `/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/appConnectorGroup/216196257331370400`,
      ),
      `restore hit ${tenant[0].url}`,
    )

    const body = bodyOf(tenant[0])
    assert.equal(body?.id, '216196257331370400', 'the replace-style PUT must echo the id back')
    assert.equal(body?.description, 'live description set by hand')
    assert.equal(body?.enabled, false)
    assert.equal(body?.location, 'Frankfurt, DE', 'the recorded prior location, not a default')
    assert.equal(body?.latitude, '50.1109')
    assert.equal(body?.longitude, '8.6821')
    assert.equal(body?.countryCode, 'DE')
    assert.equal(body?.dnsQueryType, 'IPV6')
    assert.equal(body?.versionProfileId, '0')
    assert.equal(body?.cityCountry, 'Frankfurt, DE')

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups rollback: deletes a group deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.ok(tenant[0].url.includes('/appConnectorGroup/216196257331370999'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups rollback: undoes the newest change first', async () => {
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

test('zpa-app-connector-groups rollback: a group already gone is not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back 1/)
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups rollback: a group still referenced cannot be deleted, and that is reported', async () => {
  // ZPA refuses to delete an App Connector group a server group still points at.
  // That has to surface as a message an operator can act on, not a crash.
  const { restore } = recordFetch([
    TOKEN,
    zpaError(400, 'app connector group is referenced by a server group'),
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /referenced by a server group/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
