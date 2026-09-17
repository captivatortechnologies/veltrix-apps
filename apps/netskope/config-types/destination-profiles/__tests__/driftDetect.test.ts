// driftDetect for destination-profiles.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here: the network set a policy
// matches on, and the match type that decides how it is interpreted.
//
// NOTE: `description` and `label_ids` are deliberately not asserted. The handler
// does not diff them, so a profile relabelled in the console reports as in sync —
// see the report accompanying these tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/profiles\/destinations/
const PROFILE = item('veltrix-alpha', { name: 'veltrix-alpha', type: 'regex', values: '10.0.0.0/8,10.1.0.0/16' })

registerDriftContract({
  label: 'destination-profiles',
  handler: driftDetect,
  basePath: '/profiles/destinations',
  items: [PROFILE],
  inSync: [{ profile_id: '4102', name: 'veltrix-alpha', type: 'regex', values: ['10.0.0.0/8', '10.1.0.0/16'] }],
  missingField: 'veltrix-alpha',
})

test('destination-profiles driftDetect: reports a network range added in the console', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([{ profile_id: '4102', name: 'veltrix-alpha', type: 'regex', values: ['10.0.0.0/8', '10.1.0.0/16', '0.0.0.0/0'] }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([PROFILE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.values')
    assert.ok(diff, `expected a values diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /0\.0\.0\.0\/0/)
  } finally {
    restore()
  }
})

test('destination-profiles driftDetect: reports the match type changed', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([{ profile_id: '4102', name: 'veltrix-alpha', type: 'insensitive', values: ['10.0.0.0/8', '10.1.0.0/16'] }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([PROFILE]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.type')
    assert.ok(diff, `expected a type diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'regex')
    assert.equal(diff.actual, 'insensitive')
  } finally {
    restore()
  }
})

test('destination-profiles driftDetect: treats a reordered network set as unchanged', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([{ profile_id: '4102', name: 'veltrix-alpha', type: 'regex', values: ['10.1.0.0/16', '10.0.0.0/8'] }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([PROFILE]))

    assert.equal(result.hasDrift, false, `order is not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
