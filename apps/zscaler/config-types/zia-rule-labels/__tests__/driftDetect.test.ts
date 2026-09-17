// driftDetect for zia-rule-labels.
//
// The shared contract covers the invariants: drift never writes, a deleted label
// is critical drift, and a 500 is never reported as the label being gone. What
// is specific here is the comparison itself — a rule label is name + description,
// so `description` is the only managed field there is — and the attribution that
// rides on the live object's `lastModifiedBy`.

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

const LABEL = item('Critical Egress', { name: 'Critical Egress', description: 'desired description' })

registerDriftContract({
  label: 'zia-rule-labels',
  handler: driftDetect,
  product: 'zia',
  items: [LABEL],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 4001,
  name: 'Critical Egress',
  description: 'desired description',
  ...over,
})

test('zia-rule-labels driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([LABEL]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-rule-labels driftDetect: reports a changed description', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ description: 'edited in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([LABEL]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Critical Egress.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'desired description')
    assert.equal(diff.actual, 'edited in the ZIA console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-rule-labels driftDetect: a description cleared in the console is drift, and reads as "not set"', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ description: '   ' })])])
  try {
    const result = await driftDetect(driftContext([LABEL]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Critical Egress.description')
    assert.ok(diff)
    assert.equal(diff.actual, 'not set')
  } finally {
    restore()
  }
})

test('zia-rule-labels driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        description: 'edited in the ZIA console',
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([LABEL]))

    const diff = result.diffs.find((d) => d.field === 'Critical Egress.description') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-rule-labels driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        description: 'edited by the pipeline',
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([LABEL]))

    const diff = result.diffs.find((d) => d.field === 'Critical Egress.description') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
