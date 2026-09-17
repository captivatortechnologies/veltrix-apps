// deploy for aig-appliances.
//
// An AI Gateway appliance is the box AI traffic passes through, and its record
// carries billing weight (the SKU add-ons) as well as routing. Beyond the shared
// contract: the canvas declares AI provider and MCP server NAMES that resolve
// against two other collections, both of which must fail closed; and the create
// response carries a ONE-TIME JWT enrollment token that must never be read into
// the platform's rollback record.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  bodyOf,
  created,
  deployContext,
  item,
  leaks,
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

const BASE = '/aig/appliances'
const BASE_RE = /\/aig\/appliances/
const PROVIDERS_RE = /\/aig\/aiproviders/
const MCP_RE = /\/aig\/mcpservers/

/** The one-time enrollment token Netskope returns on create. Distinctive on
 *  purpose: this string in rollbackData is secret material in platform storage. */
const ENROLLMENT_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.ENROLLMENT-JWT-MUST-NOT-BE-STORED'

/** The two collections the deploy resolves names against. Registered FIRST. */
const referenceRoutes = [
  { url: PROVIDERS_RE, method: 'GET', respond: list([{ provider_id: '11', name: 'openai-prod' }]) },
  { url: MCP_RE, method: 'GET', respond: list([{ server_id: '22', name: 'mcp-docs' }]) },
] as const

const appliance = (name: string) =>
  item(name, {
    name,
    host: 'aig-1.acme.test',
    http_enable: false,
    http_port: 80,
    https_enable: true,
    https_port: 443,
    ai_provider_ids: 'openai-prod',
    mcp_server_ids: 'mcp-docs',
    sku_addons: '[{"productCode":"NK-A-AIGW-10K","quantity":2}]',
  })

/** The same appliance as the TENANT holds it — plain HTTP enabled, a bigger
 *  capacity pack, and no MCP server attached. */
const liveAppliance = (name: string, id: string) => ({
  id,
  name,
  host: 'legacy-aig.acme.test',
  ports: { http: { enable: true, port: 8080 }, https: { enable: true, port: 8443 } },
  ai_provider_ids: ['11'],
  mcp_server_ids: [],
  sku_addons: [{ product_code: 'NK-A-AIGW-100K', quantity: 1 }],
})

registerDeployGuardContract({
  label: 'aig-appliances',
  handler: deploy,
  items: [appliance('veltrix-alpha')],
  listPath: BASE,
  extraRoutes: [...referenceRoutes],
})

registerCrudDeployContract({
  label: 'aig-appliances',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PATCH',
  item: appliance,
  live: liveAppliance,
  createdBody: (name, id) => ({ id, name, enrollment_token: ENROLLMENT_TOKEN }),
  extraRoutes: [...referenceRoutes],
  assertPrior: (prior) => {
    assert.equal(prior.host, 'legacy-aig.acme.test', 'the recorded prior must be the LIVE host')
    assert.deepEqual(
      prior.ports,
      { http: { enable: true, port: 8080 }, https: { enable: true, port: 8443 } },
      'the prior port configuration is what rollback restores',
    )
    assert.deepEqual(prior.sku_addons, [{ product_code: 'NK-A-AIGW-100K', quantity: 1 }], 'capacity packs are billed')
    assert.deepEqual(prior.mcp_server_ids, [])
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.host, 'aig-1.acme.test')
    assert.deepEqual(body.ports, { http: { enable: false, port: 80 }, https: { enable: true, port: 443 } })
    assert.deepEqual(body.ai_provider_ids, ['11'], 'the declared provider NAME must reach the wire as its id')
    assert.deepEqual(body.mcp_server_ids, ['22'])
    assert.deepEqual(body.sku_addons, [{ product_code: 'NK-A-AIGW-10K', quantity: 2 }])
  },
})

test('aig-appliances deploy: never reads the one-time enrollment token out of the create response', async () => {
  // The token enrolls the physical box. Recording it would put a credential for
  // the appliance into the platform's deployment record in clear.
  const { restore } = routeFetch([
    ...referenceRoutes,
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001', name: 'veltrix-alpha', enrollment_token: ENROLLMENT_TOKEN }) },
  ])
  try {
    const result = await deploy(deployContext([appliance('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    assert.equal(leaks(result, ENROLLMENT_TOKEN), false, 'the enrollment token must not reach rollbackData')
  } finally {
    restore()
  }
})

test('aig-appliances deploy: refuses an appliance referencing an AI provider that does not exist', async () => {
  const { calls, restore } = routeFetch([
    ...referenceRoutes,
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', host: 'aig-1.acme.test', ai_provider_ids: 'no-such-provider' })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown AI provider \/ MCP server/)
    assert.match(String(result.message), /no-such-provider/)
    assert.equal(writeCalls(calls).length, 0, 'an appliance with no resolvable provider would pass no AI traffic')
  } finally {
    restore()
  }
})

test('aig-appliances deploy: fails closed when the AI providers cannot be read', async () => {
  const { calls, restore } = routeFetch([
    { url: PROVIDERS_RE, method: 'GET', respond: serverError('provider service unavailable') },
    referenceRoutes[1],
    { url: BASE_RE, method: 'GET', respond: list([]) },
  ])
  try {
    const result = await deploy(deployContext([appliance('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list AI providers/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('aig-appliances deploy: fails closed when the MCP servers cannot be read', async () => {
  const { calls, restore } = routeFetch([
    referenceRoutes[0],
    { url: MCP_RE, method: 'GET', respond: serverError('mcp service unavailable') },
    { url: BASE_RE, method: 'GET', respond: list([]) },
  ])
  try {
    const result = await deploy(deployContext([appliance('veltrix-alpha')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list MCP servers/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('aig-appliances deploy: sends an empty sku_addons list rather than omitting it', async () => {
  // Omitting the capacity packs on an update would leave whatever the tenant is
  // billed for in place, so a pack could never be removed through the canvas.
  const { calls, restore } = routeFetch([
    ...referenceRoutes,
    { url: BASE_RE, method: 'GET', respond: list([liveAppliance('veltrix-alpha', '4102')]) },
    { url: BASE_RE, method: 'PATCH', respond: ok({ id: '4102' }) },
  ])
  try {
    await deploy(deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', host: 'aig-1.acme.test' })]))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.deepEqual(body.sku_addons, [])
    assert.deepEqual(body.ai_provider_ids, [])
    assert.deepEqual(body.mcp_server_ids, [])
  } finally {
    restore()
  }
})

test('aig-appliances deploy: omits the quantity of a capacity pack that declares none', async () => {
  const { calls, restore } = routeFetch([
    ...referenceRoutes,
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([
        item('veltrix-alpha', { name: 'veltrix-alpha', host: 'aig-1.acme.test', sku_addons: '[{"productCode":"NK-A-AIGW-10K"}]' }),
      ]),
    )

    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.sku_addons, [{ product_code: 'NK-A-AIGW-10K' }])
  } finally {
    restore()
  }
})

test('aig-appliances deploy: defaults https on and http off when the canvas says nothing', async () => {
  const { calls, restore } = routeFetch([
    ...referenceRoutes,
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ id: '9001' }) },
  ])
  try {
    await deploy(deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', host: 'aig-1.acme.test' })]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.ports, {
      http: { enable: false, port: 80 },
      https: { enable: true, port: 443 },
    })
  } finally {
    restore()
  }
})
