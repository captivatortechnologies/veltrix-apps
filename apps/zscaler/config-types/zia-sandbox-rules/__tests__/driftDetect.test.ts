// driftDetect for zia-sandbox-rules.
//
// The shared contract covers the invariants: drift never writes, a deleted rule
// is critical drift, and a 500 is never reported as the rule being gone. What is
// specific here is the comparison itself — this handler diffs only the two
// first-class scalars, `order` and `state`, so those are what these tests pin,
// along with the attribution that rides on the live rule's `lastModifiedBy`.
//
// NOTE: the Sandbox action (`ba_rule_action`) and the rest of the rule_json body
// that deploy WRITES are deliberately not asserted here — this handler does not
// compare them, so a rule flipped from BLOCK to ALLOW in the ZIA console comes
// back "in sync". See the report accompanying these tests; asserting it would
// bless it.

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

const RULE = item('Block Malicious Files', {
  name: 'Block Malicious Files',
  order: '2',
  state: 'ENABLED',
  rule_json: JSON.stringify({ ba_rule_action: 'BLOCK' }),
})

registerDriftContract({
  label: 'zia-sandbox-rules',
  handler: driftDetect,
  product: 'zia',
  items: [RULE],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  name: 'Block Malicious Files',
  order: 2,
  state: 'ENABLED',
  ba_rule_action: 'BLOCK',
  ...over,
})

test('zia-sandbox-rules driftDetect: reports no drift when the tenant matches', async () => {
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

test('zia-sandbox-rules driftDetect: reports a rule moved in the evaluation order', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ order: 9 })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Block Malicious Files.order')
    assert.ok(diff, `expected an order diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 2)
    assert.equal(diff.actual, 9)
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-sandbox-rules driftDetect: reports a rule disabled in the console as a warning', async () => {
  // A sandbox rule switched off stops blocking anything — the reason this type
  // has drift detection at all.
  const { restore } = recordFetch([TOKEN, ziaList([live({ state: 'DISABLED' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Block Malicious Files.state')
    assert.ok(diff, `expected a state diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'ENABLED')
    assert.equal(diff.actual, 'DISABLED')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zia-sandbox-rules driftDetect: reports a sandbox action flipped from BLOCK to ALLOW', async () => {
  // The whole point of a sandbox rule. Drift compared order and state and not
  // this, so a rule switched to ALLOW in the console stopped quarantining
  // malware and every scheduled run reported the estate in sync.
  const { calls, restore } = recordFetch([TOKEN, ziaList([live({ ba_rule_action: 'ALLOW' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Block Malicious Files.ba_rule_action')
    assert.ok(diff, `expected an action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'BLOCK')
    assert.equal(diff.actual, 'ALLOW')
    assert.equal(diff.severity, 'critical')
    assert.equal(writeCalls(calls).length, 0, 'drift must never write')
  } finally {
    restore()
  }
})

test('zia-sandbox-rules driftDetect: an action the tenant no longer reports is not read as a match', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ ba_rule_action: undefined })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block Malicious Files.ba_rule_action')
    assert.ok(diff, 'an unreadable action is reported, not skipped')
    assert.equal(diff.actual, 'not set')
  } finally {
    restore()
  }
})

test('zia-sandbox-rules driftDetect: a rule that declares no action cannot drift on one', async () => {
  // A rule left on the tenant default is not managed here, so whatever the
  // console shows for it is not this canvas's business.
  const unmanaged = item('Block Malicious Files', {
    name: 'Block Malicious Files',
    order: '2',
    state: 'ENABLED',
  })
  const { restore } = recordFetch([TOKEN, ziaList([live({ ba_rule_action: 'ALLOW' })])])
  try {
    const result = await driftDetect(driftContext([unmanaged]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('zia-sandbox-rules driftDetect: a state ZIA echoes in lower case is not drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ state: 'enabled' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, false, 'the state comparison is case-insensitive')
  } finally {
    restore()
  }
})

test('zia-sandbox-rules driftDetect: attributes a manual change to the admin who made it', async () => {
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

    const diff = result.diffs.find((d) => d.field === 'Block Malicious Files.state') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-sandbox-rules driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        order: 9,
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block Malicious Files.order') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
