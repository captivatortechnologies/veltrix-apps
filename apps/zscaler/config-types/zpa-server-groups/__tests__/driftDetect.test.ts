// driftDetect for zpa-server-groups.
//
// The shared contract covers the invariants. What is specific here is the
// comparison — description, enabled and dynamicDiscovery — and ZPA's own
// attribution shape, where the modifier is a bare admin id in `modifiedBy` plus
// an epoch-second STRING in `modifiedTime`, rather than ZIA's id/name pair.
//
// NOTE: the membership deploy writes (appConnectorGroups, servers) is NOT
// compared by this handler, so no test here asserts anything about it — see the
// report. Asserting the current behaviour would bless it.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  item,
  recordFetch,
  settingsWithoutCustomerId,
  writeCalls,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'

const GROUP = item('Prod Web Tier', {
  name: 'Prod Web Tier',
  description: 'desired description',
  enabled: true,
  dynamic_discovery: false,
  app_connector_groups: 'Frankfurt Connectors',
  servers: 'web-01',
})

registerDriftContract({
  label: 'zpa-server-groups',
  handler: driftDetect,
  product: 'zpa',
  items: [GROUP],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: '216196257331370400',
  name: 'Prod Web Tier',
  description: 'desired description',
  enabled: true,
  dynamicDiscovery: false,
  appConnectorGroups: [{ id: '216196257331370501', name: 'Frankfurt Connectors' }],
  servers: [{ id: '216196257331370601', name: 'web-01' }],
  ...over,
})

test('zpa-server-groups driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([live()])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zpa-server-groups driftDetect: reports a description edited in the portal', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ description: 'edited by hand' })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Prod Web Tier.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'desired description')
    assert.equal(diff.actual, 'edited by hand')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zpa-server-groups driftDetect: reports a group someone disabled by hand', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ enabled: false })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Prod Web Tier.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zpa-server-groups driftDetect: reports dynamic discovery switched on behind our back', async () => {
  // Discovery back on means the group no longer routes to the declared servers
  // alone — the members change without any member field changing.
  const { restore } = recordFetch([TOKEN, zpaList([live({ dynamicDiscovery: true })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Prod Web Tier.dynamicDiscovery')
    assert.ok(diff, `expected a dynamicDiscovery diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'false')
    assert.equal(diff.actual, 'true')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zpa-server-groups driftDetect: attributes a manual change to the ZPA admin id that made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, modifiedBy: '216196257331370351', modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Prod Web Tier.enabled') as
      | { actor?: { id?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.id, '216196257331370351')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zpa-server-groups driftDetect: does not attribute our own deploy as a manual change', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, modifiedBy: CLIENT_ID, modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Prod Web Tier.enabled') as
      | { actor?: { id?: string } }
      | undefined
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'a change recorded under our own OneAPI client is not a manual change')
  } finally {
    restore()
  }
})

test('zpa-server-groups driftDetect: makes no call without a ZPA customer id', async () => {
  // NOTE: what this returns on this path is deliberately not asserted — see the
  // report. It cannot address the tenant at all, yet answers like a clean check.
  const { calls, restore } = recordFetch([])
  try {
    await driftDetect(driftContext([GROUP], { settings: settingsWithoutCustomerId() }))

    assert.equal(calls.length, 0, 'ZPA is unaddressable without a customer id')
  } finally {
    restore()
  }
})
