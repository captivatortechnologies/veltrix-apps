// rollback for aig-ai-providers.
//
// The shared contracts cover the refusals and the restore/delete paths. What is
// specific here: the certificate is write-only, so a restore cannot carry one —
// the restored provider keeps whatever certificate the tenant already holds, and
// the rollback must not invent one.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/aig\/aiproviders/
const PRIOR = { name: 'veltrix-alpha', schema: 'azureopenai', host: 'legacy.internal', port: 8443, protocol: 'http' }

registerRollbackGuardContract({ label: 'aig-ai-providers', handler: rollback })

registerCrudRollbackContract({
  label: 'aig-ai-providers',
  handler: rollback,
  basePath: '/aig/aiproviders',
  updateMethod: 'PUT',
  prior: PRIOR,
  assertRestoreBody: (body) => {
    assert.equal(body.host, 'legacy.internal')
    assert.equal(body.port, 8443)
    assert.equal(body.protocol, 'http')
    assert.equal(body.schema, 'azureopenai')
  },
})

test('aig-ai-providers rollback: sends no certificate, because none was ever recorded', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: ok({ provider_id: '4102' }) }])
  try {
    await rollback(rollbackContext({ entries: [{ name: 'veltrix-alpha', existed: true, id: '4102', prior: PRIOR }] }))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal(
      'certificate' in body,
      false,
      'the API never returns the certificate, so a restore must not send a made-up one',
    )
  } finally {
    restore()
  }
})
