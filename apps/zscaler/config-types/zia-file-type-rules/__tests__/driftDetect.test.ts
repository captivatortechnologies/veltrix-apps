// driftDetect for zia-file-type-rules.
//
// The shared contract covers the invariants: drift never writes, a deleted rule
// is critical drift, and a 500 is never reported as the rule being gone. What is
// specific here is the comparison — order, action and state, all three at `info`
// severity in this type (the other policy-rule types raise action/state to
// warning), with the live action and state upper-cased before comparing — and
// the attribution that rides on the live rule's `lastModifiedBy`.
//
// The file types themselves live in the `rule_json` body, which this handler
// does not compare, so a rule narrowed to a different file type in the ZIA
// console is not asserted here — see the report.

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

const RULE = item('Caution On Spreadsheets', {
  name: 'Caution On Spreadsheets',
  order: 12,
  state: 'DISABLED',
  action: 'CAUTION',
  rule_json: JSON.stringify({ fileTypes: ['FTCATEGORY_MS_EXCEL'] }),
})

registerDriftContract({
  label: 'zia-file-type-rules',
  handler: driftDetect,
  product: 'zia',
  items: [RULE],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 505,
  name: 'Caution On Spreadsheets',
  order: 12,
  state: 'DISABLED',
  action: 'CAUTION',
  fileTypes: ['FTCATEGORY_MS_EXCEL'],
  ...over,
})

test('zia-file-type-rules driftDetect: reports no drift when the managed fields match', async () => {
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

test('zia-file-type-rules driftDetect: a rule relaxed to ALLOW in the console is drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ action: 'ALLOW' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Caution On Spreadsheets.action')
    assert.ok(diff, `expected an action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'CAUTION')
    assert.equal(diff.actual, 'ALLOW')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-file-type-rules driftDetect: vendor casing alone is not drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ action: 'caution', state: 'disabled' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, false, 'the handler upper-cases the live values before comparing')
  } finally {
    restore()
  }
})

test('zia-file-type-rules driftDetect: a re-enabled rule and a re-ordered rule are both drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ state: 'ENABLED', order: 3 })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const state = result.diffs.find((d) => d.field === 'Caution On Spreadsheets.state')
    assert.ok(state)
    assert.equal(state.expected, 'DISABLED')
    assert.equal(state.actual, 'ENABLED')

    const order = result.diffs.find((d) => d.field === 'Caution On Spreadsheets.order')
    assert.ok(order, 'rule precedence decides which rule wins — a moved rule is drift')
    assert.equal(order.expected, '12')
    assert.equal(order.actual, '3')
  } finally {
    restore()
  }
})

test('zia-file-type-rules driftDetect: attributes a manual change to the admin who made it', async () => {
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

    const diff = result.diffs.find((d) => d.field === 'Caution On Spreadsheets.action') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z', 'lastModifiedTime is epoch SECONDS')
  } finally {
    restore()
  }
})

test('zia-file-type-rules driftDetect: does not attribute our own deploy as a manual change', async () => {
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

    const diff = result.diffs.find((d) => d.field === 'Caution On Spreadsheets.action') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
