// driftDetect for aig-rate-limits.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here: the appliance scope and the
// response action.
//
// NOTE: `criteria` and `limit` are deliberately not asserted. The handler does
// not diff them — its comment says they self-heal because every deploy re-sends
// them — so a threshold widened in the console reports as in sync until the next
// deploy. See the report accompanying these tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/aig\/ratelimits/
const RULE = item('alpha', {
  name: 'alpha',
  criteria: '{"app":"chatgpt"}',
  limit: '{"requests":100}',
  appliance_ids: 'appliance-east',
  response: 'block',
})

registerDriftContract({
  label: 'aig-rate-limits',
  handler: driftDetect,
  basePath: '/aig/ratelimits',
  items: [RULE],
  inSync: [{ id: '4102', name: 'alpha', appliance_ids: ['appliance-east'], response: 'block' }],
  missingField: 'alpha',
})

test('aig-rate-limits driftDetect: reports a rule moved to a different appliance', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([{ id: '4102', name: 'alpha', appliance_ids: ['appliance-west'], response: 'block' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'alpha.appliance_ids')
    assert.ok(diff, `expected an appliance diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'appliance-east')
    assert.equal(diff.actual, 'appliance-west')
  } finally {
    restore()
  }
})

test('aig-rate-limits driftDetect: reports a block action relaxed to allow', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([{ id: '4102', name: 'alpha', appliance_ids: ['appliance-east'], response: 'allow' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'alpha.response')
    assert.ok(diff, `expected a response diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'block')
    assert.equal(diff.actual, 'allow')
  } finally {
    restore()
  }
})

test('aig-rate-limits driftDetect: treats a reordered appliance list as unchanged', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([{ id: '4102', name: 'alpha', appliance_ids: ['b', 'a'], response: 'block' }]),
    },
  ])
  try {
    const result = await driftDetect(
      driftContext([item('alpha', { name: 'alpha', criteria: '{}', limit: '{}', appliance_ids: 'a,b', response: 'block' })]),
    )

    assert.equal(result.hasDrift, false, `order is not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
