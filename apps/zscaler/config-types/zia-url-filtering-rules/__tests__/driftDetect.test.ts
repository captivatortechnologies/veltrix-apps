// driftDetect for zia-url-filtering-rules.
//
// The shared contract covers the invariants: drift never writes, a deleted rule
// is critical drift, and a 500 is never reported as the rule being gone. What is
// specific here is the comparison itself — order, action and state, with action
// and state as WARNINGS because they decide whether traffic is blocked — plus
// the attribution that rides on the live rule's `lastModifiedBy`.
//
// Two things deploy writes are not compared here: the `rule_json` criteria
// (documented — ZIA normalises them server-side) and `protocols`, which is not.
// Both are left unasserted; the protocols gap is reported.

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

const RULE = item('Block adult content', {
  name: 'Block adult content',
  order: 3,
  state: 'ENABLED',
  action: 'BLOCK',
  protocols: 'HTTP_RULE\nHTTPS_RULE',
})

registerDriftContract({
  label: 'zia-url-filtering-rules',
  handler: driftDetect,
  product: 'zia',
  items: [RULE],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 5150,
  name: 'Block adult content',
  order: 3,
  state: 'ENABLED',
  action: 'BLOCK',
  protocols: ['HTTP_RULE', 'HTTPS_RULE'],
  urlCategories: ['OTHER_ADULT_MATERIAL'],
  ...over,
})

test('zia-url-filtering-rules driftDetect: reports no drift when the tenant matches', async () => {
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

test('zia-url-filtering-rules driftDetect: a rule switched from BLOCK to ALLOW is a warning', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ action: 'ALLOW' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Block adult content.action')
    assert.ok(diff, `expected an action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'BLOCK')
    assert.equal(diff.actual, 'ALLOW')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules driftDetect: a rule disabled in the console is a warning', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ state: 'DISABLED' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Block adult content.state')
    assert.ok(diff)
    assert.equal(diff.expected, 'ENABLED')
    assert.equal(diff.actual, 'DISABLED')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules driftDetect: a re-ordered rule is reported', async () => {
  // Order decides which rule matches first, so a rule moved below a broader ALLOW
  // stops taking effect without anything else changing.
  const { restore } = recordFetch([TOKEN, ziaList([live({ order: 11 })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'Block adult content.order')
    assert.ok(diff)
    assert.equal(diff.expected, '3')
    assert.equal(diff.actual, '11')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules driftDetect: a blank order in the canvas is compared against ZIA order 1', async () => {
  const noOrder = item('Block gambling', { name: 'Block gambling', action: 'BLOCK', protocols: 'ANY_RULE' })
  const { restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 6002, name: 'Block gambling', order: 1, state: 'ENABLED', action: 'BLOCK' }]),
  ])
  try {
    const result = await driftDetect(driftContext([noOrder]))

    assert.equal(result.hasDrift, false, 'deploy sends order 1 when none is authored — that is not drift')
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules driftDetect: attributes a manual change to the admin who made it', async () => {
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

    const diff = result.diffs.find((d) => d.field === 'Block adult content.action') as
      | { actor?: { name?: string; email?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z', 'ZIA records epoch SECONDS')
  } finally {
    restore()
  }
})

test('zia-url-filtering-rules driftDetect: does not attribute our own deploy as a manual change', async () => {
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

    const diff = result.diffs.find((d) => d.field === 'Block adult content.action') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
