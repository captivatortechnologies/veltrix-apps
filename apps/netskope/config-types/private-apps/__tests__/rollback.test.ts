// rollback for private-apps.
//
// The shared contracts cover the refusals and the restore/delete paths. What is
// specific here: the restore sends the whole prior spec — Netskope's PUT
// replaces the app, so a partial body would clear the fields it omits — and it
// puts back the publisher steering that was in place before the deploy.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/steering\/apps\/private/
const PRIOR = {
  app_name: 'veltrix-alpha',
  host: 'legacy.internal',
  protocols: [{ type: 'tcp', port: '8080' }],
  publishers: [{ publisher_id: '77', publisher_name: 'pub-east' }],
  clientless_access: false,
  use_publisher_dns: false,
  trust_self_signed_certs: true,
}

registerRollbackGuardContract({ label: 'private-apps', handler: rollback })

registerCrudRollbackContract({
  label: 'private-apps',
  handler: rollback,
  basePath: '/steering/apps/private',
  updateMethod: 'PUT',
  prior: PRIOR,
  assertRestoreBody: (body) => {
    assert.equal(body.host, 'legacy.internal')
    assert.deepEqual(body.protocols, [{ type: 'tcp', port: '8080' }])
    assert.deepEqual(body.publishers, [{ publisher_id: '77', publisher_name: 'pub-east' }])
    assert.equal(body.trust_self_signed_certs, true)
  },
})

test('private-apps rollback: sends every managed field, because the PUT replaces the app', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: ok({ app_id: '4102' }) }])
  try {
    await rollback(rollbackContext({ entries: [{ name: 'veltrix-alpha', existed: true, id: '4102', prior: PRIOR }] }))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        'app_name',
        'clientless_access',
        'host',
        'protocols',
        'publishers',
        'trust_self_signed_certs',
        'use_publisher_dns',
      ],
      'a field left out of a replacing PUT is a field the rollback silently clears',
    )
  } finally {
    restore()
  }
})

test('private-apps rollback: restores an app that had no publishers with an empty list, not with none', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: ok({ app_id: '4102' }) }])
  try {
    await rollback(
      rollbackContext({
        entries: [
          {
            name: 'veltrix-alpha',
            existed: true,
            id: '4102',
            prior: { ...PRIOR, publishers: [], protocols: [] },
          },
        ],
      }),
    )

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.deepEqual(body.publishers, [])
    assert.deepEqual(body.protocols, [])
  } finally {
    restore()
  }
})
