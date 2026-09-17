// deploy for aig-mcp-servers.
//
// The shared contracts cover the refusals, the create/update split and the prior
// state recorded for an update. What is specific here: the tool/resource/prompt
// allow-lists, which are what actually constrains an MCP server, and the
// write-only TLS certificate, which must reach the vendor and never the
// platform's rollback record.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import { bodyOf, created, deployContext, item, leaks, list, ok, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/aig/mcpservers'
const BASE_RE = /\/aig\/mcpservers/
const CERTIFICATE = '-----BEGIN CERTIFICATE-----MUST-NOT-BE-STORED-----END CERTIFICATE-----'

const server = (name: string) =>
  item(name, {
    name,
    host: 'mcp.acme.test',
    port: 8443,
    path: '/mcp',
    protocol: 'https',
    schema: 'streamable-http',
    certificate: CERTIFICATE,
    tools: 'search,fetch',
    resources: 'docs',
    prompts: 'summarise',
  })

/** The same server as the TENANT holds it — different endpoint AND a wider tool
 *  allow-list, so a prior built from the canvas is caught. */
const liveServer = (name: string, id: string) => ({
  server_id: id,
  name,
  host: 'legacy.internal',
  port: 80,
  path: '/old',
  protocol: 'http',
  schema: 'sse',
  tools: ['search', 'fetch', 'shell_exec'],
  resources: [],
  prompts: [],
})

registerDeployGuardContract({
  label: 'aig-mcp-servers',
  handler: deploy,
  items: [server('veltrix-alpha')],
  listPath: BASE,
})

registerCrudDeployContract({
  label: 'aig-mcp-servers',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PUT',
  item: server,
  live: liveServer,
  createdBody: (name, id) => ({ server_id: id, name }),
  assertPrior: (prior) => {
    assert.equal(prior.host, 'legacy.internal', 'the recorded prior must be the LIVE host')
    assert.equal(prior.port, 80)
    assert.equal(prior.path, '/old')
    assert.equal(prior.protocol, 'http')
    assert.deepEqual(prior.tools, ['search', 'fetch', 'shell_exec'], 'the prior tool allow-list is what rollback restores')
    assert.equal(leaks(prior, CERTIFICATE), false, 'the write-only certificate must never be recorded')
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.host, 'mcp.acme.test')
    assert.equal(body.port, 8443)
    assert.equal(body.path, '/mcp')
    assert.deepEqual(body.tools, ['search', 'fetch'])
    assert.deepEqual(body.resources, ['docs'])
    assert.deepEqual(body.prompts, ['summarise'])
    assert.equal(body.certificate, CERTIFICATE)
  },
})

test('aig-mcp-servers deploy: never puts the certificate in the result it hands the platform', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([liveServer('veltrix-alpha', '4102')]) },
    { url: BASE_RE, method: 'PUT', respond: ok({ server_id: '4102' }) },
  ])
  try {
    const result = await deploy(deployContext([server('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    assert.equal(leaks(result, CERTIFICATE), false)
  } finally {
    restore()
  }
})

test('aig-mcp-servers deploy: sends an empty allow-list rather than omitting it', async () => {
  // Omitting `tools` on an update would leave whatever the tenant already allows
  // in place — the opposite of what an emptied canvas field asks for.
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ server_id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', host: 'mcp.acme.test', port: 8443, path: '/mcp', protocol: 'https' })]),
    )

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.deepEqual(body.tools, [])
    assert.deepEqual(body.resources, [])
    assert.deepEqual(body.prompts, [])
    assert.equal('schema' in body, false, 'a blank schema is omitted, not sent as ""')
    assert.equal('certificate' in body, false)
  } finally {
    restore()
  }
})
