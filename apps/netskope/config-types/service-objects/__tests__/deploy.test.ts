// deploy for service-objects.
//
// A service object is a named port/protocol group that firewall and steering
// policies reference. Beyond the shared contract: Netskope ships PREDEFINED
// built-ins, and this app must never match, update, delete or reconcile one —
// overwriting "HTTPS" would change every policy that references it.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  BASE_URL,
  bodyOf,
  created,
  deployContext,
  item,
  list,
  ok,
  priorDeployment,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/profiles/serviceobjects'
const BASE_RE = /\/profiles\/serviceobjects/

const serviceObject = (name: string) =>
  item(name, { name, description: 'Managed by Veltrix', icmp: false, tcp: '443,8443', udp: '', tcp_udp: '' })

/** The same object as the TENANT holds it — a wider port set with ICMP on. */
const liveObject = (name: string, id: string) => ({
  id,
  name,
  description: 'edited in the console',
  protocols: { icmp: true, tcp: ['22', '443'], udp: ['53'] },
  type: 'custom',
})

registerDeployGuardContract({
  label: 'service-objects',
  handler: deploy,
  items: [serviceObject('veltrix-alpha')],
  listPath: BASE,
})

registerCrudDeployContract({
  label: 'service-objects',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PATCH',
  item: serviceObject,
  live: liveObject,
  createdBody: (name, id) => ({ id, name }),
  assertPrior: (prior) => {
    assert.equal(prior.description, 'edited in the console', 'the recorded prior must be the LIVE description')
    assert.equal(prior.icmp, true, 'a rollback must put ICMP back exactly as the tenant had it')
    assert.deepEqual(prior.tcp, ['22', '443'], 'the prior port set is what rollback restores')
    assert.deepEqual(prior.udp, ['53'])
    assert.deepEqual(prior.tcp_udp, [])
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.deepEqual(body.protocols, { tcp: ['443', '8443'] }, 'only the protocols the canvas declares are sent')
  },
})

test('service-objects deploy: never matches a Netskope PREDEFINED object by name', async () => {
  // Matching the built-in would turn a create into an update of a Netskope-owned
  // object that every policy in the tenant may reference.
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([{ id: '1', name: 'veltrix-alpha', type: 'PREDEFINED' }]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    const result = await deploy(deployContext([serviceObject('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'POST', 'a name collision with a built-in creates a new custom object')
    assert.equal(writes[0].url, `${BASE_URL}${BASE}`)
  } finally {
    restore()
  }
})

test('service-objects deploy: recognises a predefined type whatever its case', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([{ id: '1', name: 'veltrix-alpha', type: 'Predefined' }]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    await deploy(deployContext([serviceObject('veltrix-alpha')]))

    assert.equal(writeCalls(calls)[0].method, 'POST')
  } finally {
    restore()
  }
})

test('service-objects deploy: sends icmp only when it is declared', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    await deploy(deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', icmp: true, tcp_udp: '1000-2000' })]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.protocols, { icmp: true, tcp_udp: ['1000-2000'] })
  } finally {
    restore()
  }
})

test('service-objects deploy: deletes an object it created previously and no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
    { url: BASE_RE, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await deploy(
      deployContext([serviceObject('veltrix-alpha')], {
        latestDeployment: priorDeployment([{ name: 'veltrix-retired', existed: false, id: '7777' }]),
      }),
    )

    assert.equal(result.success, true, result.message)
    const deletes = writeCalls(calls).filter((x) => x.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.equal(deletes[0].url, `${BASE_URL}${BASE}/7777`)
  } finally {
    restore()
  }
})
