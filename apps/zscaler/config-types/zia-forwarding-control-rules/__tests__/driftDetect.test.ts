// driftDetect for zia-forwarding-control-rules.
//
// The shared contract covers the invariants: drift never writes, a deleted rule
// is critical drift, and a 500 is never reported as the rule being gone. What is
// specific here is that FOUR fields are compared, not three — order (info), plus
// type, forwardMethod and state at warning severity — and that the
// forwardMethod diff is reported under the canvas's key (`forward_method`), not
// the vendor's. A rule quietly moved from ZPA to DIRECT sends traffic straight
// out instead of through the tunnel, which is exactly what this catches.
//
// The forwarding targets live in the `rule_json` body, which this handler does
// not compare, so a rule re-pointed at a different gateway is not asserted here
// — see the report.

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

const RULE = item('Route Branch To ZPA', {
  name: 'Route Branch To ZPA',
  order: 8,
  state: 'DISABLED',
  type: 'FORWARDING',
  forward_method: 'ZPA',
  rule_json: JSON.stringify({ zpaGateway: { id: 501 } }),
})

registerDriftContract({
  label: 'zia-forwarding-control-rules',
  handler: driftDetect,
  product: 'zia',
  items: [RULE],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 907,
  name: 'Route Branch To ZPA',
  order: 8,
  state: 'DISABLED',
  type: 'FORWARDING',
  forwardMethod: 'ZPA',
  zpaGateway: { id: 501, name: 'Branch gateway' },
  ...over,
})

test('zia-forwarding-control-rules driftDetect: reports no drift when the managed fields match', async () => {
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

test('zia-forwarding-control-rules driftDetect: a rule switched from ZPA to DIRECT is drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ forwardMethod: 'DIRECT' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Route Branch To ZPA.forward_method')
    assert.ok(diff, `expected a forward_method diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'ZPA')
    assert.equal(diff.actual, 'DIRECT')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules driftDetect: a re-typed rule is drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ type: 'DNS' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Route Branch To ZPA.type')
    assert.ok(diff, `expected a type diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'FORWARDING')
    assert.equal(diff.actual, 'DNS')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules driftDetect: a re-enabled rule and a re-ordered rule are both drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ state: 'ENABLED', order: 2 })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const state = result.diffs.find((d) => d.field === 'Route Branch To ZPA.state')
    assert.ok(state)
    assert.equal(state.expected, 'DISABLED')
    assert.equal(state.actual, 'ENABLED')
    assert.equal(state.severity, 'warning')

    const order = result.diffs.find((d) => d.field === 'Route Branch To ZPA.order')
    assert.ok(order, 'rule precedence decides which rule wins — a moved rule is drift')
    assert.equal(order.expected, '8')
    assert.equal(order.actual, '2')
    assert.equal(order.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        forwardMethod: 'DIRECT',
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Route Branch To ZPA.forward_method') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z', 'lastModifiedTime is epoch SECONDS')
  } finally {
    restore()
  }
})

test('zia-forwarding-control-rules driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        forwardMethod: 'DIRECT',
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Route Branch To ZPA.forward_method') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
