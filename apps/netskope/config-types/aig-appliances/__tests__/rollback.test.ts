// rollback for aig-appliances — the shared refusals plus the restore/delete
// paths. The restore puts back the host, the port configuration, the attached
// providers/MCP servers and the capacity packs the tenant held; the capacity
// packs in particular are billed, so restoring the wrong ones costs money.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/aig\/appliances/
const PRIOR = {
  name: 'veltrix-alpha',
  host: 'legacy-aig.acme.test',
  ports: { http: { enable: true, port: 8080 }, https: { enable: true, port: 8443 } },
  ai_provider_ids: ['11'],
  mcp_server_ids: [],
  sku_addons: [{ product_code: 'NK-A-AIGW-100K', quantity: 1 }],
}

registerRollbackGuardContract({ label: 'aig-appliances', handler: rollback })

registerCrudRollbackContract({
  label: 'aig-appliances',
  handler: rollback,
  basePath: '/aig/appliances',
  updateMethod: 'PATCH',
  prior: PRIOR,
  assertRestoreBody: (body) => {
    assert.equal(body.host, 'legacy-aig.acme.test')
    assert.deepEqual(body.ports, { http: { enable: true, port: 8080 }, https: { enable: true, port: 8443 } })
    assert.deepEqual(body.sku_addons, [{ product_code: 'NK-A-AIGW-100K', quantity: 1 }])
  },
})

test('aig-appliances rollback: restores every managed field, emptied lists included', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PATCH', respond: ok({ id: '4102' }) }])
  try {
    await rollback(rollbackContext({ entries: [{ name: 'veltrix-alpha', existed: true, id: '4102', prior: PRIOR }] }))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.deepEqual(Object.keys(body).sort(), [
      'ai_provider_ids',
      'host',
      'mcp_server_ids',
      'name',
      'ports',
      'sku_addons',
    ])
    assert.deepEqual(body.mcp_server_ids, [], 'an appliance that had no MCP servers must not gain one on rollback')
  } finally {
    restore()
  }
})
