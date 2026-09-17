// deploy for dns-profiles.
//
// Beyond the shared contract, two things are specific to DNS profiles: the three
// nested config blobs are canvas JSON that has to reach the wire as objects (and
// be omitted, not sent as null, when the canvas leaves them blank), and the
// listing can answer "migration in progress" once on a tenant that is being
// upgraded, which is retried rather than failed.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  badRequest,
  bodyOf,
  created,
  deployContext,
  item,
  list,
  ok,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/profiles/dns'
const BASE_RE = /\/profiles\/dns/

const profile = (name: string) =>
  item(name, {
    name,
    description: 'Managed by Veltrix',
    log_traffic: 'All DNS',
    domain_config: '{"action":"block"}',
  })

/** The same profile as the TENANT holds it — logging only blocked lookups. */
const liveProfile = (name: string, id: string) => ({
  profile_id: id,
  name,
  description: 'edited in the console',
  log_traffic: 'Blocked DNS',
  domain_config: { action: 'allow', materialised_default: true },
})

registerDeployGuardContract({
  label: 'dns-profiles',
  handler: deploy,
  items: [profile('veltrix-alpha')],
  listPath: BASE,
})

registerCrudDeployContract({
  label: 'dns-profiles',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PATCH',
  item: profile,
  live: liveProfile,
  createdBody: (name, id) => ({ profile_id: id, name }),
  assertPrior: (prior) => {
    assert.equal(prior.description, 'edited in the console', 'the recorded prior must be the LIVE description')
    assert.equal(prior.log_traffic, 'Blocked DNS', 'the prior logging mode is what rollback restores')
    assert.deepEqual(
      prior.domain_config,
      { action: 'allow', materialised_default: true },
      'the prior blob is recorded with the defaults the API materialised into it',
    )
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.log_traffic, 'All DNS')
    assert.deepEqual(body.domain_config, { action: 'block' }, 'the canvas JSON blob must reach the wire as an object')
  },
})

test('dns-profiles deploy: omits a config blob the canvas leaves blank', async () => {
  // Sending an empty object would wipe the tenant's materialised defaults for
  // that blob; omitting the key leaves them alone.
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ profile_id: '9001' }) },
  ])
  try {
    await deploy(deployContext([item('veltrix-alpha', { name: 'veltrix-alpha' })]))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('domain_config' in body, false)
    assert.equal('tunnel_config' in body, false)
    assert.equal('custom_config' in body, false)
    assert.equal(body.log_traffic, 'Blocked DNS', 'the logging mode defaults, it is never sent blank')
  } finally {
    restore()
  }
})

test('dns-profiles deploy: retries a listing that answered "migration in progress"', async () => {
  // Tenants mid-upgrade reject the first read of this collection. Failing there
  // would abort the whole deploy for a transient condition.
  const { calls, restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: [badRequest('profile migration in progress, retry shortly'), list([])],
    },
    { url: BASE_RE, method: 'POST', respond: created({ profile_id: '9001' }) },
  ])
  try {
    const result = await deploy(deployContext([profile('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    assert.equal(calls.filter((c) => c.method === 'GET').length, 2, 'the listing is read twice')
    assert.equal(writeCalls(calls).length, 1)
  } finally {
    restore()
  }
})

test('dns-profiles deploy: does not retry a listing rejected for an unrelated reason', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'GET', respond: badRequest('malformed request') }])
  try {
    const result = await deploy(deployContext([profile('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.equal(calls.filter((c) => c.method === 'GET').length, 1, 'only a migration answer is worth retrying')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('dns-profiles deploy: matches a profile the tenant keys under `id`', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([{ id: '4102', name: 'veltrix-alpha' }]) },
    { url: BASE_RE, method: 'PATCH', respond: ok({ id: '4102' }) },
  ])
  try {
    const result = await deploy(deployContext([profile('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    assert.match(writeCalls(calls)[0].url, /\/profiles\/dns\/4102$/)
  } finally {
    restore()
  }
})
