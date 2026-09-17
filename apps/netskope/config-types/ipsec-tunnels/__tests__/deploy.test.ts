// deploy for ipsec-tunnels.
//
// Like GRE tunnels these are keyed on SITE and validated against the live IPSec
// POP inventory. What makes this config type different is the PRE-SHARED KEY: it
// is secret, it is write-only (the API never returns it), and it therefore has
// to reach the vendor on every write while never reaching the rollback record
// the platform stores.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  bodyOf,
  deployContext,
  item,
  leaks,
  npaData,
  npaList,
  ok,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/steering/ipsec/tunnels'
const BASE_RE = /\/steering\/ipsec\/tunnels/
const POPS_RE = /\/steering\/ipsec\/pops/

/** Distinctive on purpose — this string in rollbackData is a leaked PSK. */
const PSK = 'pre-shared-key-MUST-NOT-BE-STORED'

const popsRoute = { url: POPS_RE, method: 'GET', respond: npaList('pops', [{ name: 'EU-West' }]) } as const

const tunnel = (site: string) =>
  item(site, {
    site,
    source_ip: '203.0.113.10',
    pop_names: 'EU-West',
    psk: PSK,
    encryption: 'AES256',
    bandwidth: 50,
    enabled: true,
    notes: 'Managed by Veltrix',
    reauth: true,
    rekey: true,
  })

/** The same tunnel as the TENANT holds it — weaker encryption, disabled, and no
 *  rekey. The psk is absent because the API never returns it. */
const liveTunnel = (site: string, id: string) => ({
  tunnel_id: id,
  site,
  source_ip: '198.51.100.7',
  pop_names: ['EU-West'],
  encryption: 'AES128',
  bandwidth: 10,
  enabled: false,
  notes: 'edited in the console',
  options: { reauth: false, rekey: false, xff: { enabled: false, iplist: [] } },
})

registerDeployGuardContract({
  label: 'ipsec-tunnels',
  handler: deploy,
  items: [tunnel('london-dc')],
  listPath: BASE,
  extraRoutes: [popsRoute],
})

registerCrudDeployContract({
  label: 'ipsec-tunnels',
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
    assert.equal(prior.encryption, 'AES128')
    assert.equal(prior.bandwidth, 10)
    assert.equal(prior.enabled, false, 'a tunnel that was disabled must roll back to disabled')
    assert.deepEqual(prior.options, { reauth: false, rekey: false, xff: { enabled: false, iplist: [] } })
    assert.equal(leaks(prior, PSK), false, 'the write-only pre-shared key must never be recorded')
  },
  assertCreateBody: (body) => {
    assert.equal(body.site, 'veltrix-alpha')
    assert.equal(body.source_ip, '203.0.113.10')
    assert.equal(body.psk, PSK, 'the PSK is write-only, so it must be sent on every write')
    assert.equal(body.encryption, 'AES256')
    assert.deepEqual(body.options, { reauth: true, rekey: true, xff: { enabled: false, iplist: [] } })
  },
})

test('ipsec-tunnels deploy: never puts the pre-shared key in the result it hands the platform', async () => {
  // rollbackData is stored on the deployment record. A PSK there is a site-to-site
  // tunnel secret sitting in the platform database in clear.
  const { restore } = routeFetch([
    popsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('tunnels', [liveTunnel('london-dc', '4102')]) },
    { url: BASE_RE, method: 'PUT', respond: ok({ tunnel_id: '4102' }) },
  ])
  try {
    const result = await deploy(deployContext([tunnel('london-dc')]))

    assert.equal(result.success, true, result.message)
    assert.equal(leaks(result, PSK), false, 'neither the message nor rollbackData may carry the PSK')
  } finally {
    restore()
  }
})

test('ipsec-tunnels deploy: does not echo the pre-shared key into a failure message', async () => {
  const { restore } = routeFetch([
    popsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('tunnels', []) },
    { url: BASE_RE, method: 'POST', respond: { status: 400, body: { message: 'tunnel rejected' } } },
  ])
  try {
    const result = await deploy(deployContext([tunnel('london-dc')]))

    assert.equal(result.success, false)
    assert.equal(leaks(result, PSK), false)
  } finally {
    restore()
  }
})

test('ipsec-tunnels deploy: refuses a tunnel pointed at a POP the tenant does not have', async () => {
  const { calls, restore } = routeFetch([
    popsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('tunnels', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ tunnel_id: '9001' }) },
  ])
  try {
    const result = await deploy(
      deployContext([item('london-dc', { site: 'london-dc', source_ip: '203.0.113.10', pop_names: 'MARS-1', psk: PSK })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown POP name/)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaks(result, PSK), false)
  } finally {
    restore()
  }
})

test('ipsec-tunnels deploy: omits the optional encryption and identity fields when undeclared', async () => {
  const { calls, restore } = routeFetch([
    popsRoute,
    { url: BASE_RE, method: 'GET', respond: npaList('tunnels', []) },
    { url: BASE_RE, method: 'POST', respond: npaData({ tunnel_id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([item('london-dc', { site: 'london-dc', source_ip: '203.0.113.10', pop_names: 'EU-West', psk: PSK })]),
    )

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('encryption' in body, false, 'a blank cipher must leave the tenant default in place')
    assert.equal('source_identity' in body, false)
    assert.equal('vendor' in body, false)
    assert.equal(body.bandwidth, 50, 'bandwidth defaults rather than being sent blank')
  } finally {
    restore()
  }
})
