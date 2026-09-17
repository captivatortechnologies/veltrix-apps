// driftDetect for zpa-provisioning-keys.
//
// The shared contract covers the invariants. Specific here: keys are re-found by
// name WITHIN their association type (one listing per type, however many keys),
// maxUsage comes back from ZPA as a string and is compared stringified, and the
// live listing carries the key SECRET — so every result here is checked for it.
//
// zcomponentId and enrollmentCertId are WRITTEN by deploy and not compared by
// this handler, so nothing here asserts them; see the report.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  item,
  leaksSecret,
  recordFetch,
  resourceCalls,
  settingsWithoutCustomerId,
  writeCalls,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'
import { PROVISIONING_KEY, leaksProvisioningKey } from './keySecret'

const KEY = item('SJC Connector Key', {
  name: 'SJC Connector Key',
  association_type: 'CONNECTOR_GRP',
  max_usage: 5,
  component_group_name: 'San Jose Connectors',
  enrollment_cert_name: 'Connector',
  enabled: true,
})

registerDriftContract({
  label: 'zpa-provisioning-keys',
  handler: driftDetect,
  product: 'zpa',
  items: [KEY],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: '216196257331370800',
  name: 'SJC Connector Key',
  maxUsage: '5',
  enabled: true,
  zcomponentId: 'acg-1',
  enrollmentCertId: 'cert-1',
  provisioningKey: PROVISIONING_KEY,
  ...over,
})

test('zpa-provisioning-keys driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([live()])])
  try {
    const result = await driftDetect(driftContext([KEY]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys driftDetect: reports a usage cap someone raised by hand', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ maxUsage: '99' })])])
  try {
    const result = await driftDetect(driftContext([KEY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'SJC Connector Key.maxUsage')
    assert.ok(diff, `expected a maxUsage diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '5')
    assert.equal(diff.actual, '99')
    assert.equal(diff.severity, 'warning')
    assert.equal(
      leaksProvisioningKey(result),
      false,
      'the drifted key carries its secret in the listing — a diff must not',
    )
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys driftDetect: reports a key someone disabled by hand', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ enabled: false })])])
  try {
    const result = await driftDetect(driftContext([KEY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'SJC Connector Key.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys driftDetect: labels a deleted key with its association type', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([{ id: '1', name: 'Some Other Key' }])])
  try {
    const result = await driftDetect(driftContext([KEY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'CONNECTOR_GRP/SJC Connector Key')
    assert.ok(diff, `expected a missing diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'missing')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys driftDetect: lists an association type once however many keys target it', async () => {
  const second = item('SJC Connector Key 2', {
    name: 'SJC Connector Key 2',
    association_type: 'CONNECTOR_GRP',
    max_usage: 5,
    component_group_name: 'San Jose Connectors',
    enrollment_cert_name: 'Connector',
    enabled: true,
  })
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList([live(), live({ id: '2', name: 'SJC Connector Key 2' })]),
  ])
  try {
    const result = await driftDetect(driftContext([KEY, second]))

    assert.equal(result.hasDrift, false)
    assert.equal(resourceCalls(calls).length, 1, 'one listing serves every key of the type')
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys driftDetect: attributes a manual change to the ZPA admin id that made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, modifiedBy: '216196257331370351', modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([KEY]))

    const diff = result.diffs.find((d) => d.field === 'SJC Connector Key.enabled') as
      | { actor?: { id?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.id, '216196257331370351')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys driftDetect: does not attribute drift to our own OneAPI client', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, modifiedBy: CLIENT_ID, modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([KEY]))

    const diff = result.diffs.find((d) => d.field === 'SJC Connector Key.enabled') as { actor?: unknown } | undefined
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'a change recorded under our own client id is not a manual change')
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys driftDetect: makes no call without a ZPA customer id', async () => {
  // NOTE: what this returns on this path is deliberately not asserted — see the
  // report. It cannot address the tenant at all, yet answers like a clean check.
  const { calls, restore } = recordFetch([])
  try {
    await driftDetect(driftContext([KEY], { settings: settingsWithoutCustomerId() }))

    assert.equal(calls.length, 0, 'ZPA is unaddressable without a customer id')
  } finally {
    restore()
  }
})
