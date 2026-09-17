// driftDetect for zia-firewall-rules.
//
// The shared contract covers the invariants: drift never writes, a deleted rule
// is critical drift, and a 500 is never reported as the rule being gone. What is
// specific here is the comparison itself — the three managed scalars (order,
// action, state), with action and state at warning severity because they decide
// whether traffic is blocked — plus the attribution that rides on the live
// rule's `lastModifiedBy`.
//
// The `rule_json` matching criteria are NOT compared by this handler, so a rule
// re-pointed at a different source group in the ZIA console is not asserted here
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

const RULE = item('Block Legacy Ports', {
  name: 'Block Legacy Ports',
  order: 20,
  state: 'DISABLED',
  action: 'BLOCK_RESET',
  rule_json: JSON.stringify({ srcIpGroups: [{ id: 11 }] }),
})

registerDriftContract({
  label: 'zia-firewall-rules',
  handler: driftDetect,
  product: 'zia',
  items: [RULE],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 704,
  name: 'Block Legacy Ports',
  order: 20,
  state: 'DISABLED',
  action: 'BLOCK_RESET',
  srcIpGroups: [{ id: 11, name: 'Legacy' }],
  ...over,
})

test('zia-firewall-rules driftDetect: reports no drift when the managed fields match', async () => {
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

test('zia-firewall-rules driftDetect: a rule switched to ALLOW in the console is drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ action: 'ALLOW' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Block Legacy Ports.action')
    assert.ok(diff, `expected an action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'BLOCK_RESET')
    assert.equal(diff.actual, 'ALLOW')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zia-firewall-rules driftDetect: a re-enabled rule and a re-ordered rule are both drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ state: 'ENABLED', order: 3 })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const state = result.diffs.find((d) => d.field === 'Block Legacy Ports.state')
    assert.ok(state)
    assert.equal(state.expected, 'DISABLED')
    assert.equal(state.actual, 'ENABLED')
    assert.equal(state.severity, 'warning')

    const order = result.diffs.find((d) => d.field === 'Block Legacy Ports.order')
    assert.ok(order, 'rule precedence decides which rule wins — a moved rule is drift')
    assert.equal(order.expected, '20')
    assert.equal(order.actual, '3')
    assert.equal(order.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-firewall-rules driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        action: 'ALLOW',
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block Legacy Ports.action') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z', 'lastModifiedTime is epoch SECONDS')
  } finally {
    restore()
  }
})

test('zia-firewall-rules driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        action: 'ALLOW',
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block Legacy Ports.action') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
