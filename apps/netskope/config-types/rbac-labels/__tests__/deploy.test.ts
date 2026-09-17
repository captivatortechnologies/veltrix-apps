// deploy for rbac-labels.
//
// The shared contracts cover the refusals, the create/update split, the rename
// match and the prior state recorded for an update. What is specific here: the
// body Netskope wants (`name`, and `color` only when one is declared), and the
// reconcile pass that deletes a label THIS app created and no longer declares.

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

const BASE = '/rbac/labels'

/** One declared label. The colour is what the canvas wants. */
const label = (name: string) => item(name, { name, color: '#112233' })

/** The same label as the TENANT holds it — a different colour, so a handler that
 *  recorded the desired value instead of the live one is caught. */
const liveLabel = (name: string, id: string) => ({ id, name, color: '#ffeedd' })

registerDeployGuardContract({
  label: 'rbac-labels',
  handler: deploy,
  items: [label('veltrix-alpha')],
  listPath: BASE,
})

registerCrudDeployContract({
  label: 'rbac-labels',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PATCH',
  item: label,
  live: liveLabel,
  createdBody: (name, id) => ({ id, name, color: '#112233' }),
  assertPrior: (prior) => {
    assert.equal(prior.name, 'veltrix-alpha')
    assert.equal(prior.color, '#ffeedd', 'the recorded prior must be the LIVE colour, not the one being written')
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.color, '#112233')
  },
})

test('rbac-labels deploy: omits color entirely when none is declared', async () => {
  // Netskope rejects an empty colour string; the body must simply not carry the
  // key when the canvas left it blank.
  const { calls, restore } = routeFetch([
    { url: /\/rbac\/labels/, method: 'GET', respond: list([]) },
    { url: /\/rbac\/labels/, method: 'POST', respond: created({ id: '9001', name: 'veltrix-alpha' }) },
  ])
  try {
    const result = await deploy(deployContext([item('veltrix-alpha', { name: 'veltrix-alpha' })]))

    assert.equal(result.success, true, result.message)
    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal('color' in body, false, 'a blank colour must be omitted, not sent as ""')
  } finally {
    restore()
  }
})

test('rbac-labels deploy: deletes a label it created previously and no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/rbac\/labels/, method: 'GET', respond: list([liveLabel('veltrix-alpha', '4102')]) },
    { url: /\/rbac\/labels/, method: 'PATCH', respond: ok({ id: '4102' }) },
    { url: /\/rbac\/labels/, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await deploy(
      deployContext([label('veltrix-alpha')], {
        latestDeployment: priorDeployment([
          { name: 'veltrix-alpha', existed: true, id: '4102' },
          { name: 'veltrix-retired', existed: false, id: '7777' },
        ]),
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

test('rbac-labels deploy: never deletes a label it did not create', async () => {
  // `existed: true` means the label was already in the tenant when this app first
  // saw it. Reconciling it away would delete somebody else's object.
  const { calls, restore } = routeFetch([
    { url: /\/rbac\/labels/, method: 'GET', respond: list([]) },
    { url: /\/rbac\/labels/, method: 'POST', respond: created({ id: '9001', name: 'veltrix-alpha' }) },
  ])
  try {
    await deploy(
      deployContext([label('veltrix-alpha')], {
        latestDeployment: priorDeployment([{ name: 'someone-elses-label', existed: true, id: '5555' }]),
      }),
    )

    assert.equal(
      writeCalls(calls).filter((x) => x.method === 'DELETE').length,
      0,
      'a pre-existing label must never be reconciled away',
    )
  } finally {
    restore()
  }
})
