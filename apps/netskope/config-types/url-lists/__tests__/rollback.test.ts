// rollback for url-lists.
//
// Same two-phase write as deploy: a restore or a delete is only STAGED until the
// apply POST commits it. The shared contracts cover the refusals and the
// restore/delete/404/error paths; what is specific here is that the revert is
// applied, and that an entry the handler declines to touch does not trigger an
// apply of its own.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { BASE_URL, callsTo, notFound, ok, rollbackContext, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/policy/urllist'
const APPLY_RE = /\/policy\/urllist\/deploy/
const LIST_RE = /\/policy\/urllist/

registerRollbackGuardContract({ label: 'url-lists', handler: rollback })

registerCrudRollbackContract({
  label: 'url-lists',
  handler: rollback,
  basePath: BASE,
  updateMethod: 'PUT',
  prior: { name: 'veltrix-alpha', urls: ['legacy.example'], type: 'regex' },
  ignoreWrites: APPLY_RE,
  extraRoutes: [{ url: APPLY_RE, method: 'POST', respond: ok() }],
  assertRestoreBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.deepEqual(body.data, { urls: ['legacy.example'], type: 'regex' }, 'the restore writes back the prior urls and type')
  },
})

test('url-lists rollback: applies the staged revert', async () => {
  const { calls, restore } = routeFetch([
    { url: APPLY_RE, method: 'POST', respond: ok() },
    { url: LIST_RE, method: 'PUT', respond: ok({ id: '4102' }) },
    { url: LIST_RE, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'veltrix-alpha', existed: true, id: '4102', prior: { name: 'veltrix-alpha', urls: ['legacy.example'], type: 'regex' } },
          { name: 'veltrix-beta', existed: false, id: '9001' },
        ],
      }),
    )

    assert.equal(result.success, true, result.message)
    const applies = callsTo(calls, APPLY_RE)
    assert.equal(applies.length, 1, 'a staged revert that is never applied has not rolled anything back')
    assert.equal(calls[calls.length - 1].url, `${BASE_URL}${BASE}/deploy`)
  } finally {
    restore()
  }
})

test('url-lists rollback: issues no apply when it staged nothing', async () => {
  // Neither entry is actionable — one was created with no id captured, the other
  // was updated with no prior recorded. Applying here would commit unrelated
  // pending edits made by somebody else in the console.
  const { calls, restore } = routeFetch([], ok())
  try {
    await rollback(
      rollbackContext({
        entries: [
          { name: 'veltrix-alpha', existed: false },
          { name: 'veltrix-beta', existed: true, id: '4102' },
        ],
      }),
    )

    assert.equal(callsTo(calls, APPLY_RE).length, 0, 'nothing staged means nothing to apply')
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('url-lists rollback: reports a failed apply rather than claiming the revert took effect', async () => {
  const { restore } = routeFetch([
    { url: APPLY_RE, method: 'POST', respond: notFound('deploy endpoint unavailable') },
    { url: LIST_RE, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'veltrix-beta', existed: false, id: '9001' }] }))

    assert.equal(result.success, false, 'a revert that was staged but never applied is not a completed rollback')
    assert.match(String(result.message), /deploy endpoint unavailable/)
  } finally {
    restore()
  }
})
