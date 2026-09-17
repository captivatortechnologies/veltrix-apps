// driftDetect for zpa-segment-groups.
//
// The shared contract covers the invariants. What is specific here is the
// comparison — description and enabled — and ZPA's own attribution shape, where
// the modifier is a bare admin id in `modifiedBy` rather than ZIA's id/name pair.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  TOKEN,
  driftContext,
  item,
  recordFetch,
  settingsWithoutCustomerId,
  writeCalls,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'

const GROUP = item('Corp Apps', { name: 'Corp Apps', description: 'desired description', enabled: true })

registerDriftContract({
  label: 'zpa-segment-groups',
  handler: driftDetect,
  product: 'zpa',
  items: [GROUP],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: '216196257331370400',
  name: 'Corp Apps',
  description: 'desired description',
  enabled: true,
  ...over,
})

test('zpa-segment-groups driftDetect: reports no drift when the tenant matches', async () => {
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

test('zpa-segment-groups driftDetect: reports a group someone disabled by hand', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ enabled: false })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Corp Apps.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zpa-segment-groups driftDetect: attributes a manual change to the ZPA admin id that made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, modifiedBy: '216196257331370351', modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Corp Apps.enabled') as
      | { actor?: { id?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.id, '216196257331370351')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zpa-segment-groups driftDetect: makes no call without a ZPA customer id', async () => {
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
