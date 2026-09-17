// deploy for device-classification-tags.
//
// The shared contracts cover the refusals, the create/update split, the rename
// match and the prior state recorded for an update. What is specific here: the
// body Netskope wants (`name` + `description`), and that a tag this app did not
// create is never reconciled away.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  BASE_URL,
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

const BASE = '/deviceclassification/tags'
const BASE_RE = /\/deviceclassification\/tags/

const tag = (name: string) => item(name, { name, description: 'Managed by Veltrix' })

/** The same tag as the TENANT holds it — a description someone edited by hand. */
const liveTag = (name: string, id: string) => ({ id, name, description: 'edited in the console' })

registerDeployGuardContract({
  label: 'device-classification-tags',
  handler: deploy,
  items: [tag('veltrix-alpha')],
  listPath: BASE,
})

registerCrudDeployContract({
  label: 'device-classification-tags',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PUT',
  item: tag,
  live: liveTag,
  createdBody: (name, id) => ({ id, name, description: 'Managed by Veltrix' }),
  assertPrior: (prior) => {
    assert.equal(prior.name, 'veltrix-alpha')
    assert.equal(
      prior.description,
      'edited in the console',
      'the recorded prior must be the LIVE description, not the one being written',
    )
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.description, 'Managed by Veltrix')
  },
})

test('device-classification-tags deploy: deletes a tag it created previously and no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001', name: 'veltrix-alpha' }) },
    { url: BASE_RE, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await deploy(
      deployContext([tag('veltrix-alpha')], {
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

test('device-classification-tags deploy: never deletes a tag it did not create', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([tag('veltrix-alpha')], {
        latestDeployment: priorDeployment([{ name: 'someone-elses-tag', existed: true, id: '5555' }]),
      }),
    )

    assert.equal(writeCalls(calls).filter((x) => x.method === 'DELETE').length, 0)
  } finally {
    restore()
  }
})
