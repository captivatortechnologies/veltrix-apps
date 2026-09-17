// deploy for url-lists.
//
// URL lists are the one config type in this app with a two-phase write: every
// create/update/delete only STAGES a change, and `POST /policy/urllist/deploy`
// applies all pending url-list changes on the tenant. So on top of the shared
// create/update/record contract this file asserts the apply step itself — that
// it follows a write, that it is NOT issued when nothing was written (an apply
// with nothing staged would still commit somebody else's pending edits), and
// that an apply that fails is reported rather than silently leaving the tenant
// half-applied.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  BASE_URL,
  bodyOf,
  callsTo,
  created,
  deployContext,
  forbidden,
  item,
  list,
  ok,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/policy/urllist'
const APPLY_RE = /\/policy\/urllist\/deploy/
const LIST_RE = /\/policy\/urllist/

const urlList = (name: string) => item(name, { name, type: 'exact', urls: 'a.example\nb.example' })

/** The same list as the TENANT holds it — different urls AND a different match
 *  type, so a handler that recorded the desired values is caught. */
const liveList = (name: string, id: string) => ({ id, name, data: { urls: ['legacy.example'], type: 'regex' } })

/** The apply route must be registered BEFORE the collection route: its URL is a
 *  prefix match of the collection's, and both are POSTs. */
const applyRoute = { url: APPLY_RE, method: 'POST', respond: ok() } as const

registerDeployGuardContract({
  label: 'url-lists',
  handler: deploy,
  items: [urlList('veltrix-alpha')],
  listPath: BASE,
  extraRoutes: [applyRoute],
})

registerCrudDeployContract({
  label: 'url-lists',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PUT',
  item: urlList,
  live: liveList,
  createdBody: (name, id) => ({ id, name, data: { urls: ['a.example', 'b.example'], type: 'exact' } }),
  extraRoutes: [applyRoute],
  ignoreWrites: APPLY_RE,
  assertPrior: (prior) => {
    assert.deepEqual(prior.urls, ['legacy.example'], 'the recorded prior must be the LIVE urls')
    assert.equal(prior.type, 'regex', 'the recorded prior must be the LIVE match type, not the one being written')
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.deepEqual(body.data, { urls: ['a.example', 'b.example'], type: 'exact' })
  },
})

test('url-lists deploy: applies the staged change after writing, and only once', async () => {
  const { calls, restore } = routeFetch([
    applyRoute,
    { url: LIST_RE, method: 'GET', respond: list([]) },
    { url: LIST_RE, method: 'POST', respond: created({ id: '9001', name: 'veltrix-alpha' }) },
  ])
  try {
    const result = await deploy(deployContext([urlList('veltrix-alpha'), urlList('veltrix-beta')]))

    assert.equal(result.success, true, result.message)
    const applies = callsTo(calls, APPLY_RE)
    assert.equal(applies.length, 1, 'the tenant-wide apply is issued once per deploy, not once per list')
    assert.equal(applies[0].method, 'POST')
    assert.equal(applies[0].url, `${BASE_URL}${BASE}/deploy`)
    // The apply must come last — applying before the writes would commit nothing.
    assert.equal(calls[calls.length - 1].url, `${BASE_URL}${BASE}/deploy`)
  } finally {
    restore()
  }
})

test('url-lists deploy: issues no apply when nothing was written', async () => {
  // Every declared list was rejected, so nothing is staged. An apply here would
  // commit whatever else happens to be pending on the tenant — changes this
  // deploy did not make and cannot roll back.
  const { calls, restore } = routeFetch([
    applyRoute,
    { url: LIST_RE, method: 'GET', respond: list([]) },
    { url: LIST_RE, method: 'POST', respond: forbidden('not authorized to create url lists') },
  ])
  try {
    const result = await deploy(deployContext([urlList('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.equal(
      callsTo(calls, APPLY_RE).length,
      0,
      'nothing was staged, so nothing may be applied',
    )
  } finally {
    restore()
  }
})

test('url-lists deploy: reports a failed apply instead of reporting a deploy that never took effect', async () => {
  // The writes were staged but the apply was refused: the tenant is left with
  // pending changes that are not enforced. Reporting success here would tell the
  // operator a policy is live when it is not.
  const { restore } = routeFetch([
    { url: APPLY_RE, method: 'POST', respond: serverError('apply failed') },
    { url: LIST_RE, method: 'GET', respond: list([]) },
    { url: LIST_RE, method: 'POST', respond: created({ id: '9001', name: 'veltrix-alpha' }) },
  ])
  try {
    const result = await deploy(deployContext([urlList('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /apply failed/)
    const entries = (result.rollbackData as { entries?: Array<{ id?: string }> }).entries ?? []
    assert.equal(entries.length, 1, 'the staged list still exists in the tenant and must stay recoverable')
    assert.equal(entries[0].id, '9001')
  } finally {
    restore()
  }
})

test('url-lists deploy: a failed write is reported and the successful one is still applied', async () => {
  const { calls, restore } = routeFetch([
    applyRoute,
    { url: LIST_RE, method: 'GET', respond: list([]) },
    {
      url: LIST_RE,
      method: 'POST',
      respond: [created({ id: '9001', name: 'veltrix-alpha' }), forbidden('quota exceeded')],
    },
  ])
  try {
    const result = await deploy(deployContext([urlList('veltrix-alpha'), urlList('veltrix-beta')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /veltrix-beta/)
    assert.equal(callsTo(calls, APPLY_RE).length, 1, 'the list that WAS staged must not be left pending')
  } finally {
    restore()
  }
})

test('url-lists deploy: deletes a list it created previously and no longer declares, then applies', async () => {
  const { calls, restore } = routeFetch([
    applyRoute,
    { url: LIST_RE, method: 'GET', respond: list([liveList('veltrix-alpha', '4102')]) },
    { url: LIST_RE, method: 'PUT', respond: ok({ id: '4102' }) },
    { url: LIST_RE, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await deploy(
      deployContext([urlList('veltrix-alpha')], {
        latestDeployment: {
          id: 'dep-0',
          canvasId: 'canvas-1',
          status: 'SUCCEEDED',
          healthScore: 100,
          startedAt: '2026-01-01T09:00:00.000Z',
          completedAt: '2026-01-01T09:05:00.000Z',
          environment: { id: 'env-1', name: 'production' },
          rollbackData: { entries: [{ name: 'veltrix-retired', existed: false, id: '7777' }] },
        },
      }),
    )

    assert.equal(result.success, true, result.message)
    const deletes = writeCalls(calls).filter((x) => x.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.equal(deletes[0].url, `${BASE_URL}${BASE}/7777`)
    assert.equal(callsTo(calls, APPLY_RE).length, 1, 'a staged delete needs the apply too')
  } finally {
    restore()
  }
})

test('url-lists deploy: sends the urls exactly as declared, split on newlines and commas', async () => {
  const { calls, restore } = routeFetch([
    applyRoute,
    { url: LIST_RE, method: 'GET', respond: list([]) },
    { url: LIST_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', type: 'regex', urls: ' a.example , b.example \n c.example ' })]),
    )

    const write = writeCalls(calls).find((x) => !APPLY_RE.test(x.url))
    const body = bodyOf(write) ?? {}
    assert.deepEqual(body.data, { urls: ['a.example', 'b.example', 'c.example'], type: 'regex' })
  } finally {
    restore()
  }
})
