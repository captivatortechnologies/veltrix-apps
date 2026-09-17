// deploy for aig-rate-limits.
//
// The shared contracts cover the refusals, the create/update split and the prior
// state recorded for an update. What is specific here: `criteria` and `limit`
// are canvas JSON blobs that have to reach the wire as objects, and the
// appliance list is what scopes the rule.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import { bodyOf, created, deployContext, item, list, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/aig/ratelimits'
const BASE_RE = /\/aig\/ratelimits/

const rule = (name: string) =>
  item(name, {
    name,
    criteria: '{"app":"chatgpt"}',
    limit: '{"requests":100,"window":"minute"}',
    appliance_ids: 'appliance-east',
    response: 'block',
  })

/** The same rule as the TENANT holds it — a looser limit on a different
 *  appliance, so a prior built from the canvas is caught. */
const liveRule = (name: string, id: string) => ({
  id,
  name,
  criteria: { app: 'legacy' },
  limit: { requests: 10000, window: 'hour' },
  appliance_ids: ['appliance-west'],
  response: 'allow',
})

registerDeployGuardContract({
  label: 'aig-rate-limits',
  handler: deploy,
  items: [rule('alpha')],
  listPath: BASE,
})

registerCrudDeployContract({
  label: 'aig-rate-limits',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PUT',
  item: rule,
  live: liveRule,
  createdBody: (name, id) => ({ id, name }),
  assertPrior: (prior) => {
    assert.deepEqual(prior.criteria, { app: 'legacy' }, 'the recorded prior must be the LIVE criteria')
    assert.deepEqual(prior.limit, { requests: 10000, window: 'hour' })
    assert.deepEqual(prior.appliance_ids, ['appliance-west'])
    assert.equal(prior.response, 'allow')
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.deepEqual(body.criteria, { app: 'chatgpt' }, 'the canvas JSON blob must reach the wire as an object')
    assert.deepEqual(body.limit, { requests: 100, window: 'minute' })
    assert.deepEqual(body.appliance_ids, ['appliance-east'])
    assert.equal(body.response, 'block')
  },
})

test('aig-rate-limits deploy: omits response when the canvas leaves it blank', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([item('alpha', { name: 'alpha', criteria: '{"app":"x"}', limit: '{"requests":5}', appliance_ids: 'a1' })]),
    )

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('response' in body, false, 'a blank response leaves the tenant default in place')
    assert.deepEqual(body.appliance_ids, ['a1'])
  } finally {
    restore()
  }
})

test('aig-rate-limits deploy: matches a rule the tenant returns under rule_id', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([{ rule_id: '4102', name: 'alpha', criteria: {}, limit: {} }]) },
    { url: BASE_RE, method: 'PUT', respond: { status: 200, body: { rule_id: '4102' } } },
  ])
  try {
    const result = await deploy(deployContext([rule('alpha')]))

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PUT')
    assert.match(writes[0].url, /\/aig\/ratelimits\/4102$/)
  } finally {
    restore()
  }
})
