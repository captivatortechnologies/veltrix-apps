// deploy for npa-local-brokers.
//
// A local broker is the on-premises hop NPA traffic takes, so its addressing
// settings decide whether remote users can reach anything at all. Beyond the
// shared contract: the canvas declares RBAC label NAMES which must resolve to
// ids before the write, and the registration/DNS state the API reports back is
// runtime-only and never sent.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  bodyOf,
  deployContext,
  item,
  list,
  npaData,
  npaList,
  ok,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/infrastructure/lbrokers'
const BASE_RE = /\/infrastructure\/lbrokers/
const LABELS_RE = /\/rbac\/labels/

/** The RBAC labels the deploy resolves names against. Registered FIRST. */
const labelsRoute = { url: LABELS_RE, method: 'GET', respond: list([{ id: '33', name: 'prod' }]) } as const

const broker = (name: string) =>
  item(name, {
    local_broker_name: name,
    access_via_public_ip: 'ON_PREM',
    custom_private_ip: '10.10.0.5',
    custom_public_ip: '',
    labels: 'prod',
    city_name: 'London',
    country_code: 'GB',
  })

/** The same broker as the TENANT holds it — reachable by a different route and
 *  in a different place. */
const liveBroker = (name: string, id: string) => ({
  local_broker_id: id,
  local_broker_name: name,
  access_via_public_ip: 'OFF_PREM',
  custom_private_ip: '10.99.0.9',
  custom_public_ip: '198.51.100.20',
  label_ids: ['33'],
  city_name: 'Manchester',
  country_code: 'GB',
})

registerDeployGuardContract({
  label: 'npa-local-brokers',
  handler: deploy,
  items: [broker('veltrix-alpha')],
  listPath: BASE,
  extraRoutes: [labelsRoute],
})

registerCrudDeployContract({
  label: 'npa-local-brokers',
  handler: deploy,
  basePath: BASE,
  listKey: 'lbrokers',
  createEnvelope: 'npa',
  updateMethod: 'PUT',
  item: broker,
  live: liveBroker,
  createdBody: (name, id) => ({ local_broker_id: id, local_broker_name: name }),
  extraRoutes: [labelsRoute],
  assertPrior: (prior) => {
    assert.equal(
      prior.access_via_public_ip,
      'OFF_PREM',
      'the recorded prior must be the LIVE reachability mode, not the one being written',
    )
    assert.equal(prior.custom_private_ip, '10.99.0.9')
    assert.equal(prior.custom_public_ip, '198.51.100.20')
    assert.equal(prior.city_name, 'Manchester')
    assert.deepEqual(prior.label_ids, ['33'])
  },
  assertCreateBody: (body) => {
    assert.equal(body.local_broker_name, 'veltrix-alpha')
    assert.equal(body.access_via_public_ip, 'ON_PREM')
    assert.equal(body.custom_private_ip, '10.10.0.5')
    assert.deepEqual(body.label_ids, ['33'], 'the declared label NAME must reach the wire as its id')
    assert.equal(body.city_name, 'London')
  },
})

test('npa-local-brokers deploy: refuses a broker whose RBAC label does not exist, without writing it', async () => {
  const { calls, restore } = routeFetch([
    labelsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('lbrokers', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ local_broker_id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('veltrix-alpha', { local_broker_name: 'veltrix-alpha', labels: 'staging' })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown RBAC label/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('npa-local-brokers deploy: fails closed when the RBAC labels cannot be read', async () => {
  const { calls, restore } = routeFetch([
    { url: LABELS_RE, method: 'GET', respond: serverError('label service unavailable') },
    { url: BASE_RE, method: 'GET', respond: npaList('lbrokers', []) },
  ])
  try {
    const result = await deploy(deployContext([broker('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list RBAC labels/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('npa-local-brokers deploy: defaults the reachability mode to NONE rather than sending it blank', async () => {
  const { calls, restore } = routeFetch([
    labelsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('lbrokers', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ local_broker_id: '9001' }) },
  ])
  try {
    await deploy(deployContext([item('veltrix-alpha', { local_broker_name: 'veltrix-alpha' })]))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal(body.access_via_public_ip, 'NONE')
    assert.deepEqual(body.label_ids, [])
  } finally {
    restore()
  }
})

test('npa-local-brokers deploy: omits latitude and longitude when the canvas leaves them unset', async () => {
  const { calls, restore } = routeFetch([
    labelsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('lbrokers', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ local_broker_id: '9001' }) },
  ])
  try {
    await deploy(deployContext([broker('veltrix-alpha')]))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('latitude' in body, false)
    assert.equal('longitude' in body, false)
  } finally {
    restore()
  }
})

test('npa-local-brokers deploy: never sends the runtime registration state back to the tenant', async () => {
  // dns_host and registration status are computed by Netskope. Echoing them
  // would be an app writing over the tenant's own runtime facts.
  const { calls, restore } = routeFetch([
    labelsRoute,
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('lbrokers', [{ ...liveBroker('veltrix-alpha', '4102'), dns_host: 'lbr-1.goskope.com', registered: true }]),
    },
    { url: BASE_RE, method: 'PUT', respond: ok({ local_broker_id: '4102' }) },
  ])
  try {
    await deploy(deployContext([broker('veltrix-alpha')]))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('dns_host' in body, false)
    assert.equal('registered' in body, false)
  } finally {
    restore()
  }
})
