// rollback for zpa-provisioning-keys.
//
// The shared contract covers the refusals and the two entries that must produce
// no call at all. Specific here: the CRUD collection is parameterized by the
// association type carried on each entry, the restore PUT has to put the prior
// usage cap and BOTH reference ids back (a default would re-point the key at
// nothing), and the restore body must not carry the key secret — rollback has
// neither the value nor any need for it.

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
import { leaksProvisioningKey } from './keySecret'

registerRollbackGuardContract({
  label: 'zpa-provisioning-keys',
  handler: rollback,
  product: 'zpa',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'SJC Connector Key',
  associationType: 'CONNECTOR_GRP',
  existed: true,
  id: '216196257331370800',
  prior: {
    name: 'SJC Connector Key',
    maxUsage: 99,
    enabled: false,
    zcomponentId: 'acg-legacy',
    enrollmentCertId: 'cert-legacy',
  },
}

const CREATED_ENTRY = {
  name: 'New Connector Key',
  associationType: 'CONNECTOR_GRP',
  existed: false,
  id: '216196257331371007',
}

test('zpa-provisioning-keys rollback: restores the prior scalars of a key deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.ok(
      tenant[0].url.includes(
        `/zpa/mgmtconfig/v1/admin/customers/${ZPA_CUSTOMER_ID}/associationType/CONNECTOR_GRP/provisioningKey/216196257331370800`,
      ),
      `restore hit ${tenant[0].url}`,
    )

    const body = bodyOf(tenant[0])
    assert.equal(body?.id, '216196257331370800', 'the replace-style PUT must echo the id back')
    assert.equal(body?.maxUsage, '99', 'the recorded prior cap, as the string ZPA wants')
    assert.equal(body?.enabled, false)
    assert.equal(body?.zcomponentId, 'acg-legacy', 'the recorded prior group, not a default')
    assert.equal(body?.enrollmentCertId, 'cert-legacy')
    assert.equal(body?.provisioningKey, undefined, 'the key value is never part of a write')
    assert.equal(leaksProvisioningKey(body), false)

    assert.equal(result.success, true)
    assert.equal(leaksProvisioningKey(result), false)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys rollback: deletes a key deploy created, under its association type', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.ok(tenant[0].url.includes('/associationType/CONNECTOR_GRP/provisioningKey/216196257331371007'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys rollback: undoes the newest change first', async () => {
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

test('zpa-provisioning-keys rollback: a key already gone is not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back 1/)
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys rollback: a key ZPA refuses to delete is reported, not thrown', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaError(400, 'provisioning key is in use by an enrolled connector'),
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /in use by an enrolled connector/)
    assert.equal(leaksProvisioningKey(result), false)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
