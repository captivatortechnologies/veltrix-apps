// deploy for private-apps.
//
// A private app is the object that actually exposes an internal host to remote
// users, so two things beyond the shared contract matter here:
//
//   * PUBLISHER RESOLUTION. The canvas declares publisher NAMES; the API wants
//     {publisher_id, publisher_name}. A name that resolves to nothing must fail
//     the item rather than deploy an app with no steering — and it must fail it
//     BEFORE the write, not after.
//   * THE FULL-REPLACE UPDATE. Netskope's PUT replaces the whole spec, so every
//     managed field has to be in the body on an update or it is cleared.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  bodyOf,
  deployContext,
  forbidden,
  item,
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

const BASE = '/steering/apps/private'
const BASE_RE = /\/steering\/apps\/private/
const PUBLISHERS_RE = /\/infrastructure\/publishers/

const PUBLISHER = { publisher_id: '77', publisher_name: 'pub-east' }

/** The publisher inventory the deploy resolves names against. Registered FIRST
 *  so it is never shadowed by the private-app routes. */
const publishersRoute = { url: PUBLISHERS_RE, method: 'GET', respond: npaList('publishers', [PUBLISHER]) } as const

const app = (name: string) =>
  item(name, {
    app_name: name,
    host: 'crm.internal',
    tcp_ports: '443,8443',
    udp_ports: '',
    publishers: 'pub-east',
    clientless_access: true,
    use_publisher_dns: true,
    trust_self_signed_certs: false,
  })

/** The same app as the TENANT holds it — a different host, a different port and
 *  the self-signed-cert trust turned ON. */
const liveApp = (name: string, id: string) => ({
  app_id: id,
  app_name: name,
  host: 'legacy.internal',
  protocols: [{ type: 'tcp', port: '8080' }],
  publishers: [PUBLISHER],
  clientless_access: false,
  use_publisher_dns: false,
  trust_self_signed_certs: true,
})

registerDeployGuardContract({
  label: 'private-apps',
  handler: deploy,
  items: [app('veltrix-alpha')],
  listPath: BASE,
  extraRoutes: [publishersRoute],
})

registerCrudDeployContract({
  label: 'private-apps',
  handler: deploy,
  basePath: BASE,
  listKey: 'private_apps',
  createEnvelope: 'npa',
  updateMethod: 'PUT',
  item: app,
  live: liveApp,
  createdBody: (name, id) => ({ app_id: id, app_name: name }),
  extraRoutes: [publishersRoute],
  assertPrior: (prior) => {
    assert.equal(prior.host, 'legacy.internal', 'the recorded prior must be the LIVE host')
    assert.deepEqual(prior.protocols, [{ type: 'tcp', port: '8080' }])
    assert.equal(prior.clientless_access, false)
    assert.equal(
      prior.trust_self_signed_certs,
      true,
      'a rollback must put back the trust setting the tenant had, not the one being written',
    )
  },
  assertCreateBody: (body) => {
    assert.equal(body.app_name, 'veltrix-alpha')
    assert.equal(body.host, 'crm.internal')
    assert.deepEqual(body.protocols, [{ type: 'tcp', port: '443,8443' }])
    assert.deepEqual(body.publishers, [{ publisher_id: '77', publisher_name: 'pub-east' }])
    assert.equal(body.clientless_access, true)
    assert.equal(body.use_publisher_dns, true)
    assert.equal(body.trust_self_signed_certs, false)
  },
})

test('private-apps deploy: refuses an app whose publisher does not exist, without writing it', async () => {
  // Creating the app anyway would publish an internal host with no publisher to
  // steer it — the app exists, reachable by nobody, and nothing says why.
  const { calls, restore } = routeFetch([
    publishersRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('private_apps', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ app_id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('veltrix-alpha', { app_name: 'veltrix-alpha', host: 'crm.internal', tcp_ports: '443', publishers: 'pub-west' })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown publisher/)
    assert.match(String(result.message), /pub-west/)
    assert.equal(writeCalls(calls).length, 0, 'the app must not be created with unresolved steering')
  } finally {
    restore()
  }
})

test('private-apps deploy: still deploys the apps whose publishers do resolve', async () => {
  const { calls, restore } = routeFetch([
    publishersRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('private_apps', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ app_id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([
        app('veltrix-alpha'),
        item('veltrix-beta', { app_name: 'veltrix-beta', host: 'hr.internal', tcp_ports: '443', publishers: 'pub-west' }),
      ]),
    )

    assert.equal(result.success, false, 'the unresolved app is still a failure')
    assert.equal(writeCalls(calls).length, 1, 'exactly the resolvable app is written')
    assert.equal(bodyOf(writeCalls(calls)[0])?.app_name, 'veltrix-alpha')
    const entries = (result.rollbackData as { entries: Array<{ name?: string }> }).entries
    assert.deepEqual(entries.map((e) => e.name), ['veltrix-alpha'])
  } finally {
    restore()
  }
})

test('private-apps deploy: accepts a publisher declared by id as well as by name', async () => {
  const { calls, restore } = routeFetch([
    publishersRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('private_apps', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ app_id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('veltrix-alpha', { app_name: 'veltrix-alpha', host: 'crm.internal', tcp_ports: '443', publishers: '77' })]),
    )

    assert.equal(result.success, true, result.message)
    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.publishers, [{ publisher_id: '77', publisher_name: 'pub-east' }])
  } finally {
    restore()
  }
})

test('private-apps deploy: fails closed when the publisher inventory cannot be read', async () => {
  // Without the inventory every declared publisher would look unresolvable, and
  // proceeding would deploy apps with an empty publisher list.
  const { calls, restore } = routeFetch([
    { url: PUBLISHERS_RE, method: 'GET', respond: serverError('publisher service unavailable') },
    { url: BASE_RE, method: 'GET', respond: npaList('private_apps', []) },
  ])
  try {
    const result = await deploy(deployContext([app('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list NPA publishers/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('private-apps deploy: sends both protocol rows when tcp and udp ports are declared', async () => {
  const { calls, restore } = routeFetch([
    publishersRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('private_apps', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ app_id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([
        item('veltrix-alpha', { app_name: 'veltrix-alpha', host: 'crm.internal', tcp_ports: '443', udp_ports: '53,123', publishers: 'pub-east' }),
      ]),
    )

    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.protocols, [
      { type: 'tcp', port: '443' },
      { type: 'udp', port: '53,123' },
    ])
  } finally {
    restore()
  }
})

test('private-apps deploy: reports a rejected update and leaves the recorded prior intact', async () => {
  const { restore } = routeFetch([
    publishersRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('private_apps', [liveApp('veltrix-alpha', '4102')]) },
    { url: BASE_RE, method: 'PUT', respond: forbidden('not authorized to modify private apps') },
  ])
  try {
    const result = await deploy(deployContext([app('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /not authorized/)
    const entries = (result.rollbackData as { entries: unknown[] }).entries
    assert.deepEqual(entries, [], 'a write that never landed leaves nothing to roll back')
  } finally {
    restore()
  }
})

test('private-apps deploy: matches an app the tenant keys under private_app_id', async () => {
  const { calls, restore } = routeFetch([
    publishersRoute,
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('private_apps', [{ private_app_id: '4102', name: 'veltrix-alpha', host: 'legacy.internal' }]),
    },
    { url: BASE_RE, method: 'PUT', respond: ok({ app_id: '4102' }) },
  ])
  try {
    const result = await deploy(deployContext([app('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.match(writes[0].url, /\/steering\/apps\/private\/4102$/)
  } finally {
    restore()
  }
})
