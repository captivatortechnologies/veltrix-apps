// driftDetect for url-lists.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here: url lists have an APPLIED
// state and a PENDING state, and drift must compare against the applied one —
// comparing against pending would report a staged-but-unenforced change as being
// in effect. The url comparison is also order-insensitive.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE = '/policy/urllist'
const URL_LIST = item('veltrix-alpha', { name: 'veltrix-alpha', type: 'exact', urls: 'a.example\nb.example' })

registerDriftContract({
  label: 'url-lists',
  handler: driftDetect,
  basePath: BASE,
  items: [URL_LIST],
  inSync: [{ id: '4102', name: 'veltrix-alpha', data: { urls: ['a.example', 'b.example'], type: 'exact' } }],
  missingField: 'veltrix-alpha',
})

test('url-lists driftDetect: reads the APPLIED state, not pending edits', async () => {
  const { calls, restore } = routeFetch([
    {
      url: /\/policy\/urllist/,
      method: 'GET',
      respond: list([{ id: '4102', name: 'veltrix-alpha', data: { urls: ['a.example', 'b.example'], type: 'exact' } }]),
    },
  ])
  try {
    await driftDetect(driftContext([URL_LIST]))

    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /pending=applied/, 'drift compares against the enforced state, not staged edits')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('url-lists driftDetect: reports urls changed in the tenant', async () => {
  const { restore } = routeFetch([
    {
      url: /\/policy\/urllist/,
      method: 'GET',
      respond: list([{ id: '4102', name: 'veltrix-alpha', data: { urls: ['a.example', 'evil.example'], type: 'exact' } }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([URL_LIST]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.urls')
    assert.ok(diff, `expected a urls diff, got ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(diff.expected, ['a.example', 'b.example'])
    assert.deepEqual(diff.actual, ['a.example', 'evil.example'])
  } finally {
    restore()
  }
})

test('url-lists driftDetect: reports the match type changed from exact to regex', async () => {
  const { restore } = routeFetch([
    {
      url: /\/policy\/urllist/,
      method: 'GET',
      respond: list([{ id: '4102', name: 'veltrix-alpha', data: { urls: ['a.example', 'b.example'], type: 'regex' } }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([URL_LIST]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.type')
    assert.ok(diff, `expected a type diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'exact')
    assert.equal(diff.actual, 'regex')
  } finally {
    restore()
  }
})

test('url-lists driftDetect: treats a reordered url list as unchanged', async () => {
  const { restore } = routeFetch([
    {
      url: /\/policy\/urllist/,
      method: 'GET',
      respond: list([{ id: '4102', name: 'veltrix-alpha', data: { urls: ['b.example', 'a.example'], type: 'exact' } }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([URL_LIST]))

    assert.equal(result.hasDrift, false, `order is not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
