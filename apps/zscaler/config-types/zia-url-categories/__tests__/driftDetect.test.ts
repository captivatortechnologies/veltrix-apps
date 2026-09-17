// driftDetect for zia-url-categories.
//
// The shared contract covers the invariants: drift never writes, a deleted
// category is critical drift, and a 500 is never reported as the category being
// gone. What is specific here is the comparison itself — the managed description
// and the URL set, compared order-independently — and the attribution that rides
// on the live object's `lastModifiedBy`.

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

const CATEGORY = item('Blocked Vendors', {
  configured_name: 'Blocked Vendors',
  description: 'desired description',
  super_category: 'USER_DEFINED',
  urls: 'a.example.com\nb.example.com',
})

registerDriftContract({
  label: 'zia-url-categories',
  handler: driftDetect,
  product: 'zia',
  items: [CATEGORY],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 'CUSTOM_01',
  configuredName: 'Blocked Vendors',
  customCategory: true,
  superCategory: 'USER_DEFINED',
  type: 'URL_CATEGORY',
  description: 'desired description',
  urls: ['a.example.com', 'b.example.com'],
  ...over,
})

test('zia-url-categories driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([CATEGORY]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-url-categories driftDetect: URL order is not drift, but a changed URL set is', async () => {
  const reordered = recordFetch([TOKEN, ziaList([live({ urls: ['b.example.com', 'a.example.com'] })])])
  try {
    const result = await driftDetect(driftContext([CATEGORY]))
    assert.equal(result.hasDrift, false, 'ZIA returns URLs in its own order — that is not a change')
  } finally {
    reordered.restore()
  }

  const changed = recordFetch([TOKEN, ziaList([live({ urls: ['a.example.com', 'attacker.example.com'] })])])
  try {
    const result = await driftDetect(driftContext([CATEGORY]))
    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Blocked Vendors.urls')
    assert.ok(diff, `expected a urls diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /attacker\.example\.com/)
  } finally {
    changed.restore()
  }
})

test('zia-url-categories driftDetect: reports a changed description', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ description: 'edited in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([CATEGORY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Blocked Vendors.description')
    assert.ok(diff)
    assert.equal(diff.expected, 'desired description')
    assert.equal(diff.actual, 'edited in the ZIA console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-url-categories driftDetect: attributes a manual change to the admin who made it', async () => {
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
    const result = await driftDetect(driftContext([CATEGORY]))

    const diff = result.diffs.find((d) => d.field === 'Blocked Vendors.description') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-url-categories driftDetect: does not attribute our own deploy as a manual change', async () => {
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
    const result = await driftDetect(driftContext([CATEGORY]))

    const diff = result.diffs.find((d) => d.field === 'Blocked Vendors.description') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
