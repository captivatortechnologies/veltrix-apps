// deploy for npa-publishers.
//
// The first NPA-enveloped config type: the listing arrives as
// `{status, data: {publishers: [...]}}` and the identity fields are
// `publisher_id` / `publisher_name`, not `id` / `name`. The shared contracts
// cover the refusals, the create/update split and the prior state recorded for
// an update; what is specific here is the local-broker connect toggle, which is
// the only managed setting and decides whether the publisher reaches the tenant
// through a local broker.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  BASE_URL,
  bodyOf,
  deployContext,
  item,
  npaData,
  npaList,
  ok,
  priorDeployment,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/infrastructure/publishers'
const BASE_RE = /\/infrastructure\/publishers/

const publisher = (name: string) => item(name, { name, lbrokerconnect: true })

/** The same publisher as the TENANT holds it — local-broker connect OFF. */
const livePublisher = (name: string, id: string) => ({
  publisher_id: id,
  publisher_name: name,
  lbrokerconnect: false,
  status: 'connected',
})

registerDeployGuardContract({
  label: 'npa-publishers',
  handler: deploy,
  items: [publisher('veltrix-alpha')],
  listPath: BASE,
})

registerCrudDeployContract({
  label: 'npa-publishers',
  handler: deploy,
  basePath: BASE,
  listKey: 'publishers',
  createEnvelope: 'npa',
  updateMethod: 'PATCH',
  item: publisher,
  live: livePublisher,
  createdBody: (name, id) => ({ publisher_id: id, publisher_name: name, lbrokerconnect: true }),
  assertPrior: (prior) => {
    assert.equal(prior.name, 'veltrix-alpha')
    assert.equal(
      prior.lbrokerconnect,
      false,
      'the recorded prior must be the LIVE broker-connect setting, not the one being written',
    )
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.lbrokerconnect, true)
  },
})

test('npa-publishers deploy: sends lbrokerconnect false when the canvas leaves it off', async () => {
  // The field is a toggle, so "absent" means false — it must be sent explicitly
  // rather than omitted, or an update can never turn it back off.
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('publishers', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ publisher_id: '9001' }) },
  ])
  try {
    await deploy(deployContext([item('veltrix-alpha', { name: 'veltrix-alpha' })]))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal(body.lbrokerconnect, false)
  } finally {
    restore()
  }
})

test('npa-publishers deploy: deletes a publisher it created previously and no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('publishers', [livePublisher('veltrix-alpha', '4102')]) },
    { url: BASE_RE, method: 'PATCH', respond: ok({ publisher_id: '4102' }) },
    { url: BASE_RE, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await deploy(
      deployContext([publisher('veltrix-alpha')], {
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

test('npa-publishers deploy: never deletes a publisher it did not create', async () => {
  // Deleting a publisher somebody else registered takes every private app that
  // steers through it offline.
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('publishers', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ publisher_id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([publisher('veltrix-alpha')], {
        latestDeployment: priorDeployment([{ name: 'shared-publisher', existed: true, id: '5555' }]),
      }),
    )

    assert.equal(writeCalls(calls).filter((x) => x.method === 'DELETE').length, 0)
  } finally {
    restore()
  }
})
