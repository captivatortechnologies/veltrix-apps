// driftDetect for zpa-application-segments.
//
// The shared contract covers the invariants. Specific here is the comparison the
// handler actually performs — description, enabled, and the domain-name SET,
// which it sorts on both sides so a reordered list is not drift — plus ZPA's own
// attribution shape (a bare admin id in `modifiedBy`, `modifiedTime` as an
// epoch-second string).

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
  settingsWithoutCustomerId,
  writeCalls,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'

const SEGMENT = item('Corp Intranet', {
  name: 'Corp Intranet',
  description: 'desired description',
  enabled: true,
  domain_names: 'intranet.corp.example\n*.apps.corp.example',
  segment_group_name: 'Corp Apps',
  server_group_names: 'DC1 Servers',
  tcp_port_ranges: '443',
  bypass_type: 'ON_NET',
  health_reporting: 'CONTINUOUS',
})

registerDriftContract({
  label: 'zpa-application-segments',
  handler: driftDetect,
  product: 'zpa',
  items: [SEGMENT],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: '216196257331370500',
  name: 'Corp Intranet',
  description: 'desired description',
  enabled: true,
  domainNames: ['intranet.corp.example', '*.apps.corp.example'],
  ...over,
})

// NOTE: segmentGroupId, serverGroups, tcpPortRange, udpPortRange, bypassType and
// healthReporting are all WRITTEN by deploy and never compared here, so no test
// asserts them — see the report.

test('zpa-application-segments driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([live()])])
  try {
    const result = await driftDetect(driftContext([SEGMENT]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zpa-application-segments driftDetect: treats the domain list as a set, not an order', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ domainNames: ['*.apps.corp.example', 'intranet.corp.example'] })]),
  ])
  try {
    const result = await driftDetect(driftContext([SEGMENT]))

    assert.equal(result.hasDrift, false, 'the same domains in a different order are not drift')
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('zpa-application-segments driftDetect: reports a domain someone added by hand', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ domainNames: ['intranet.corp.example', '*.apps.corp.example', 'payroll.corp.example'] })]),
  ])
  try {
    const result = await driftDetect(driftContext([SEGMENT]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Corp Intranet.domainNames')
    assert.ok(diff, `expected a domainNames diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '*.apps.corp.example, intranet.corp.example')
    assert.equal(diff.actual, '*.apps.corp.example, intranet.corp.example, payroll.corp.example')
    assert.equal(diff.severity, 'warning')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-application-segments driftDetect: reports a segment someone disabled or re-described by hand', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, description: 'edited in the admin portal' })]),
  ])
  try {
    const result = await driftDetect(driftContext([SEGMENT]))

    assert.equal(result.hasDrift, true)

    const enabled = result.diffs.find((d) => d.field === 'Corp Intranet.enabled')
    assert.ok(enabled, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(enabled.expected, 'true')
    assert.equal(enabled.actual, 'false')
    assert.equal(enabled.severity, 'warning')

    const description = result.diffs.find((d) => d.field === 'Corp Intranet.description')
    assert.ok(description)
    assert.equal(description.actual, 'edited in the admin portal')
    assert.equal(description.severity, 'info')
  } finally {
    restore()
  }
})

test('zpa-application-segments driftDetect: attributes a manual change to the ZPA admin id that made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, modifiedBy: '216196257331370351', modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([SEGMENT]))

    const diff = result.diffs.find((d) => d.field === 'Corp Intranet.enabled') as
      | { actor?: { id?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.id, '216196257331370351')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zpa-application-segments driftDetect: does not attribute drift to our own OneAPI client', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, modifiedBy: CLIENT_ID, modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([SEGMENT]))

    const diff = result.diffs.find((d) => d.field === 'Corp Intranet.enabled') as { actor?: unknown } | undefined
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'a change recorded under our own client id is not a manual change')
  } finally {
    restore()
  }
})

test('zpa-application-segments driftDetect: makes no call without a ZPA customer id', async () => {
  // NOTE: what this returns on this path is deliberately not asserted — see the
  // report. It cannot address the tenant at all, yet answers like a clean check.
  const { calls, restore } = recordFetch([])
  try {
    await driftDetect(driftContext([SEGMENT], { settings: settingsWithoutCustomerId() }))

    assert.equal(calls.length, 0, 'ZPA is unaddressable without a customer id')
  } finally {
    restore()
  }
})
