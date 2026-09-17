// driftDetect for custom-categories.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here is the deliberate weakening
// of the membership comparison: the canvas holds NAMES and the tenant holds ids,
// so the handler compares COUNTS. That catches an addition or a removal, and the
// tests below pin both the catch and its limit.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/profiles\/customcategories/
const CATEGORY = item('veltrix-alpha', {
  name: 'veltrix-alpha',
  description: 'Managed by Veltrix',
  included_predefined_categories: '500',
  included_url_lists: 'blocked-sites',
})

registerDriftContract({
  label: 'custom-categories',
  handler: driftDetect,
  basePath: '/profiles/customcategories',
  items: [CATEGORY],
  inSync: [
    {
      id: '4102',
      name: 'veltrix-alpha',
      description: 'Managed by Veltrix',
      included_predefined_categories: ['500'],
      included_url_lists: ['11'],
    },
  ],
  missingField: 'veltrix-alpha',
})

test('custom-categories driftDetect: reports a URL list removed from the category in the console', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([
        {
          id: '4102',
          name: 'veltrix-alpha',
          description: 'Managed by Veltrix',
          included_predefined_categories: ['500'],
          included_url_lists: [],
        },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([CATEGORY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.included_url_lists')
    assert.ok(diff, `expected a membership diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '1')
    assert.equal(diff.actual, '0')
  } finally {
    restore()
  }
})

test('custom-categories driftDetect: reports a predefined category added in the console', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([
        {
          id: '4102',
          name: 'veltrix-alpha',
          description: 'Managed by Veltrix',
          included_predefined_categories: ['500', '600'],
          included_url_lists: ['11'],
        },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([CATEGORY]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.included_predefined_categories')
    assert.ok(diff, `expected a predefined-category diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '1')
    assert.equal(diff.actual, '2')
  } finally {
    restore()
  }
})

test('custom-categories driftDetect: reports a description changed in the console', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([
        {
          id: '4102',
          name: 'veltrix-alpha',
          description: 'edited in the console',
          included_predefined_categories: ['500'],
          included_url_lists: ['11'],
        },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([CATEGORY]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'edited in the console')
  } finally {
    restore()
  }
})

test('custom-categories driftDetect: a membership SWAP of the same size is not reported', async () => {
  // Documented limitation, not an accident: declared entries are names and live
  // entries are ids, so only the count can be compared without a second lookup.
  // A URL list swapped for a different one of the same size reads as in sync.
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([
        {
          id: '4102',
          name: 'veltrix-alpha',
          description: 'Managed by Veltrix',
          included_predefined_categories: ['500'],
          included_url_lists: ['99'],
        },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([CATEGORY]))

    assert.equal(result.hasDrift, false)
    assert.notEqual(result.checked, false, 'it did look — the comparison is just coarser than the data')
  } finally {
    restore()
  }
})
