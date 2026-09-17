// deploy for gre-tunnels.
//
// A GRE tunnel is keyed on its SITE, not a name, and the deploy reads the live
// GRE POP inventory to check the declared POPs exist before it writes. Beyond
// the shared contract this file pins the POP check, the nested XFF options block
// and the fact that a tunnel disabled in the canvas is sent as disabled.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  BASE_URL,
  bodyOf,
  deployContext,
  item,
  npaData,
  npaList,
  ok,
  priorDeployment,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/steering/gre/tunnels'
const BASE_RE = /\/steering\/gre\/tunnels/
const POPS_RE = /\/steering\/gre\/pops/

/** The live POP inventory. Registered FIRST so the tunnel routes never shadow it. */
const popsRoute = { url: POPS_RE, method: 'GET', respond: npaList('pops', [{ name: 'US-East' }]) } as const

const tunnel = (site: string) =>
  item(site, {
    site,
    source_ip: '203.0.113.10',
    pop_names: 'US-East',
    bandwidth: 1000,
    enabled: true,
    notes: 'Managed by Veltrix',
    xff_enabled: true,
    xff_ip_list: '10.0.0.1',
  })

/** The same tunnel as the TENANT holds it — a different source IP, disabled, on
 *  a smaller bandwidth allocation. */
const liveTunnel = (site: string, id: string) => ({
  tunnel_id: id,
  site,
  source_ip: '198.51.100.7',
  pop_names: ['US-East'],
  bandwidth: 250,
  enabled: false,
  notes: 'edited in the console',
  options: { xff: { xff_enabled: false, xff_ip_list: [] } },
})

registerDeployGuardContract({
  label: 'gre-tunnels',
  handler: deploy,
  items: [tunnel('london-dc')],
  listPath: BASE,
  extraRoutes: [popsRoute],
})

registerCrudDeployContract({
  label: 'gre-tunnels',
  handler: deploy,
  basePath: BASE,
  listKey: 'tunnels',
  createEnvelope: 'npa',
  updateMethod: 'PUT',
  nameKey: 'site',
  item: tunnel,
  live: liveTunnel,
  createdBody: (site, id) => ({ tunnel_id: id, site }),
  extraRoutes: [popsRoute],
  assertPrior: (prior) => {
    assert.equal(prior.source_ip, '198.51.100.7', 'the recorded prior must be the LIVE source IP')
    assert.equal(prior.bandwidth, 250)
    assert.equal(prior.enabled, false, 'a tunnel that was disabled must roll back to disabled')
    assert.equal(prior.notes, 'edited in the console')
    assert.deepEqual(prior.options, { xff: { xff_enabled: false, xff_ip_list: [] } })
  },
  assertCreateBody: (body) => {
    assert.equal(body.site, 'veltrix-alpha')
    assert.equal(body.source_ip, '203.0.113.10')
    assert.deepEqual(body.pop_names, ['US-East'])
    assert.equal(body.bandwidth, 1000)
    assert.equal(body.enabled, true)
    assert.deepEqual(body.options, { xff: { xff_enabled: true, xff_ip_list: ['10.0.0.1'] } })
  },
})

test('gre-tunnels deploy: refuses a tunnel pointed at a POP the tenant does not have', async () => {
  const { calls, restore } = routeFetch([
    popsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('tunnels', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ tunnel_id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('london-dc', { site: 'london-dc', source_ip: '203.0.113.10', pop_names: 'MARS-1' })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown POP name/)
    assert.match(String(result.message), /MARS-1/)
    assert.equal(writeCalls(calls).length, 0, 'a tunnel to a POP that does not exist must not be created')
  } finally {
    restore()
  }
})

test('gre-tunnels deploy: matches a declared POP name case-insensitively', async () => {
  const { calls, restore } = routeFetch([
    popsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('tunnels', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ tunnel_id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('london-dc', { site: 'london-dc', source_ip: '203.0.113.10', pop_names: 'us-east' })]),
    )

    assert.equal(result.success, true, result.message)
    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.pop_names, ['us-east'])
  } finally {
    restore()
  }
})

test('gre-tunnels deploy: sends enabled false for a tunnel the canvas turns off', async () => {
  const { calls, restore } = routeFetch([
    popsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('tunnels', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ tunnel_id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([item('london-dc', { site: 'london-dc', source_ip: '203.0.113.10', pop_names: 'US-East', enabled: false })]),
    )

    assert.equal(bodyOf(writeCalls(calls)[0])?.enabled, false)
  } finally {
    restore()
  }
})

test('gre-tunnels deploy: omits the optional source_type, template and vendor when undeclared', async () => {
  const { calls, restore } = routeFetch([
    popsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('tunnels', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ tunnel_id: '9001' }) },
  ])
  try {
    await deploy(deployContext([item('london-dc', { site: 'london-dc', source_ip: '203.0.113.10', pop_names: 'US-East' })]))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('source_type' in body, false)
    assert.equal('template' in body, false)
    assert.equal('vendor' in body, false)
    assert.equal(body.bandwidth, 1000, 'bandwidth defaults rather than being sent blank')
  } finally {
    restore()
  }
})

test('gre-tunnels deploy: deletes a tunnel it created previously and no longer declares', async () => {
  const { calls, restore } = routeFetch([
    popsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('tunnels', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ tunnel_id: '9001' }) },
    { url: BASE_RE, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await deploy(
      deployContext([tunnel('london-dc')], {
        latestDeployment: priorDeployment([{ site: 'decommissioned-dc', existed: false, id: '7777' }]),
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
