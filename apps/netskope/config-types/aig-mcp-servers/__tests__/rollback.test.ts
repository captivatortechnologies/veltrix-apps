// rollback for aig-mcp-servers — the shared refusals plus the restore/delete
// paths. The restore body is the whole prior snapshot, including the tool
// allow-list the tenant had before the deploy widened or narrowed it.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/aig\/mcpservers/
const PRIOR = {
  name: 'veltrix-alpha',
  host: 'legacy.internal',
  port: 80,
  path: '/old',
  protocol: 'http',
  schema: 'sse',
  tools: ['search', 'fetch', 'shell_exec'],
  resources: [],
  prompts: [],
}

registerRollbackGuardContract({ label: 'aig-mcp-servers', handler: rollback })

registerCrudRollbackContract({
  label: 'aig-mcp-servers',
  handler: rollback,
  basePath: '/aig/mcpservers',
  updateMethod: 'PUT',
  prior: PRIOR,
  assertRestoreBody: (body) => {
    assert.equal(body.host, 'legacy.internal')
    assert.equal(body.path, '/old')
    assert.deepEqual(body.tools, ['search', 'fetch', 'shell_exec'])
  },
})

test('aig-mcp-servers rollback: sends no certificate, because none was ever recorded', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: ok({ server_id: '4102' }) }])
  try {
    await rollback(rollbackContext({ entries: [{ name: 'veltrix-alpha', existed: true, id: '4102', prior: PRIOR }] }))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('certificate' in body, false, 'a restore must not send a made-up certificate')
  } finally {
    restore()
  }
})
