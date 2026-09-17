// driftDetect for zpa-servers.
//
// The shared contract covers the invariants. What is specific here is the
// comparison — description, address and enabled, every field deploy writes — and
// ZPA's own attribution shape, where the modifier is a bare admin id in
// `modifiedBy` plus an epoch-second STRING in `modifiedTime`, rather than ZIA's
// id/name pair. The address is the one that matters: a server repointed at
// another host by hand still answers to the same name.

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

const SERVER = item('web-01', {
  name: 'web-01',
  description: 'desired description',
  address: 'web-01.corp.example.com',
  enabled: true,
})

registerDriftContract({
  label: 'zpa-servers',
  handler: driftDetect,
  product: 'zpa',
  items: [SERVER],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: '216196257331370400',
  name: 'web-01',
  description: 'desired description',
  address: 'web-01.corp.example.com',
  enabled: true,
  ...over,
})

test('zpa-servers driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([live()])])
  try {
    const result = await driftDetect(driftContext([SERVER]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zpa-servers driftDetect: reports a server repointed at another host', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ address: '10.20.30.99' })])])
  try {
    const result = await driftDetect(driftContext([SERVER]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'web-01.address')
    assert.ok(diff, `expected an address diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'web-01.corp.example.com')
    assert.equal(diff.actual, '10.20.30.99')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zpa-servers driftDetect: reports a description edited in the portal', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ description: 'edited by hand' })])])
  try {
    const result = await driftDetect(driftContext([SERVER]))

    const diff = result.diffs.find((d) => d.field === 'web-01.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'desired description')
    assert.equal(diff.actual, 'edited by hand')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zpa-servers driftDetect: reports a server someone disabled by hand', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ enabled: false })])])
  try {
    const result = await driftDetect(driftContext([SERVER]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'web-01.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zpa-servers driftDetect: attributes a manual change to the ZPA admin id that made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ address: '10.20.30.99', modifiedBy: '216196257331370351', modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([SERVER]))

    const diff = result.diffs.find((d) => d.field === 'web-01.address') as
      | { actor?: { id?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.id, '216196257331370351')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zpa-servers driftDetect: does not attribute our own deploy as a manual change', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ address: '10.20.30.99', modifiedBy: CLIENT_ID, modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([SERVER]))

    const diff = result.diffs.find((d) => d.field === 'web-01.address') as { actor?: { id?: string } } | undefined
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'a change recorded under our own OneAPI client is not a manual change')
  } finally {
    restore()
  }
})

test('zpa-servers driftDetect: makes no call without a ZPA customer id', async () => {
  // NOTE: what this returns on this path is deliberately not asserted — see the
  // report. It cannot address the tenant at all, yet answers like a clean check.
  const { calls, restore } = recordFetch([])
  try {
    await driftDetect(driftContext([SERVER], { settings: settingsWithoutCustomerId() }))

    assert.equal(calls.length, 0, 'ZPA is unaddressable without a customer id')
  } finally {
    restore()
  }
})
