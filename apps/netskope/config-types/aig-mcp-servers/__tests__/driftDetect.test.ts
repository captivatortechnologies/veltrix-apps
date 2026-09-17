// driftDetect for aig-mcp-servers.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here is the endpoint comparison.
//
// NOTE: the tool / resource / prompt allow-lists are deliberately not asserted.
// The handler does not diff them, so an MCP server silently granted an extra
// tool in the console reports as in sync — see the report accompanying these
// tests. Asserting the current behaviour would document that as correct.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/aig\/mcpservers/
const SERVER = item('veltrix-alpha', {
  name: 'veltrix-alpha',
  host: 'mcp.acme.test',
  port: 8443,
  path: '/mcp',
  protocol: 'https',
  tools: 'search,fetch',
})

registerDriftContract({
  label: 'aig-mcp-servers',
  handler: driftDetect,
  basePath: '/aig/mcpservers',
  items: [SERVER],
  inSync: [
    { server_id: '4102', name: 'veltrix-alpha', host: 'mcp.acme.test', port: 8443, path: '/mcp', protocol: 'https', tools: ['search', 'fetch'] },
  ],
  missingField: 'veltrix-alpha',
})

test('aig-mcp-servers driftDetect: reports a server repointed at a different endpoint', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([
        { server_id: '4102', name: 'veltrix-alpha', host: 'attacker.example', port: 80, path: '/hook', protocol: 'http' },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([SERVER]))

    assert.equal(result.hasDrift, true)
    const fields = result.diffs.map((d) => d.field).sort()
    assert.deepEqual(fields, [
      'veltrix-alpha.host',
      'veltrix-alpha.path',
      'veltrix-alpha.port',
      'veltrix-alpha.protocol',
    ])
  } finally {
    restore()
  }
})
