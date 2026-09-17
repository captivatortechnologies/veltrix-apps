// driftDetect for zia-ssl-inspection-rules.
//
// The shared contract covers the invariants: drift never writes, a deleted rule
// is critical drift, and a 500 is never reported as the rule being gone. What is
// specific here is the comparison itself — this handler diffs only the two
// first-class scalars, `order` (defaulted to 1 the same way deploy defaults it)
// and `state` — plus the attribution that rides on the live rule's
// `lastModifiedBy`.
//
// NOTE: the SSL `action` object that deploy WRITES is deliberately not asserted
// here — this handler does not compare it, so a rule switched from DECRYPT to
// DO_NOT_DECRYPT in the ZIA console comes back "in sync". See the report
// accompanying these tests; asserting it would bless it.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  item,
  recordFetch,
  writeCalls,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'

const RULE = item('Decrypt Finance', {
  name: 'Decrypt Finance',
  order: '3',
  state: 'ENABLED',
  rule_json: JSON.stringify({ action: { type: 'DECRYPT' }, urlCategories: ['FINANCE'] }),
})

registerDriftContract({
  label: 'zia-ssl-inspection-rules',
  handler: driftDetect,
  product: 'zia',
  items: [RULE],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 6001,
  name: 'Decrypt Finance',
  order: 3,
  state: 'ENABLED',
  action: { type: 'DECRYPT' },
  urlCategories: ['FINANCE'],
  ...over,
})

test('zia-ssl-inspection-rules driftDetect: reports a rule switched to DO_NOT_DECRYPT', async () => {
  // Drift compared order and state and not the action, so a rule switched in the
  // console silently stopped inspecting TLS for everything it matched — and
  // every scheduled run reported the estate in sync.
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([live({ action: { type: 'DO_NOT_DECRYPT' } })]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Decrypt Finance.action.type')
    assert.ok(diff, `expected an action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'DECRYPT')
    assert.equal(diff.actual, 'DO_NOT_DECRYPT')
    assert.equal(diff.severity, 'critical')
    assert.equal(writeCalls(calls).length, 0, 'drift must never write')
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules driftDetect: the rest of the action object is still left alone', async () => {
  // Only `type` is compared. ZIA normalises and echoes the rest, so diffing it
  // would produce phantom drift on a tenant nobody has touched.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([live({ action: { type: 'DECRYPT', sslInterceptionCert: { id: 77 }, decryptSubActions: {} } })]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules driftDetect: a rule declaring no action cannot drift on one', async () => {
  const unmanaged = item('Decrypt Finance', { name: 'Decrypt Finance', order: '3', state: 'ENABLED' })
  const { restore } = recordFetch([TOKEN, ziaList([live({ action: { type: 'DO_NOT_DECRYPT' } })])])
  try {
    const result = await driftDetect(driftContext([unmanaged]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules driftDetect: reports a rule moved in the evaluation order', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ order: 12 })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Decrypt Finance.order')
    assert.ok(diff, `expected an order diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '3')
    assert.equal(diff.actual, '12')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules driftDetect: a rule declared without an order is compared against 1', async () => {
  const unordered = item('Unordered', {
    name: 'Unordered',
    rule_json: JSON.stringify({ action: { type: 'DECRYPT' } }),
  })

  const matching = recordFetch([TOKEN, ziaList([{ id: 6010, name: 'Unordered', order: 1, state: 'ENABLED', action: { type: 'DECRYPT' } }])])
  try {
    const result = await driftDetect(driftContext([unordered]))
    assert.equal(result.hasDrift, false, 'deploy sends order 1, so order 1 is in sync')
  } finally {
    matching.restore()
  }

  const moved = recordFetch([TOKEN, ziaList([{ id: 6010, name: 'Unordered', order: 4, state: 'ENABLED', action: { type: 'DECRYPT' } }])])
  try {
    const result = await driftDetect(driftContext([unordered]))
    const diff = result.diffs.find((d) => d.field === 'Unordered.order')
    assert.ok(diff, `expected an order diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '1')
  } finally {
    moved.restore()
  }
})

test('zia-ssl-inspection-rules driftDetect: reports a rule disabled in the console as a warning', async () => {
  // An SSL inspection rule switched off stops inspecting traffic — the reason
  // this type has drift detection at all.
  const { restore } = recordFetch([TOKEN, ziaList([live({ state: 'DISABLED' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Decrypt Finance.state')
    assert.ok(diff, `expected a state diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'ENABLED')
    assert.equal(diff.actual, 'DISABLED')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        state: 'DISABLED',
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Decrypt Finance.state') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-ssl-inspection-rules driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        order: 12,
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Decrypt Finance.order') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
