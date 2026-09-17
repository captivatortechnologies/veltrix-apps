// driftDetect for aig-appliances.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here: the host, both port blocks
// and the capacity packs are diffed in full, while the attached provider and MCP
// server lists are compared by COUNT only — declared entries are names and live
// entries are ids, so a value comparison would always mismatch. The tests pin
// both the catch and its limit.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/aig\/appliances/
const APPLIANCE = item('veltrix-alpha', {
  name: 'veltrix-alpha',
  host: 'aig-1.acme.test',
  http_enable: false,
  http_port: 80,
  https_enable: true,
  https_port: 443,
  ai_provider_ids: 'openai-prod',
  sku_addons: '[{"productCode":"NK-A-AIGW-10K","quantity":2}]',
})

const liveInSync = {
  id: '4102',
  name: 'veltrix-alpha',
  host: 'aig-1.acme.test',
  ports: { http: { enable: false, port: 80 }, https: { enable: true, port: 443 } },
  ai_provider_ids: ['11'],
  mcp_server_ids: [],
  sku_addons: [{ product_code: 'NK-A-AIGW-10K', quantity: 2 }],
}

registerDriftContract({
  label: 'aig-appliances',
  handler: driftDetect,
  basePath: '/aig/appliances',
  items: [APPLIANCE],
  inSync: [liveInSync],
  missingField: 'veltrix-alpha',
})

test('aig-appliances driftDetect: reports plain HTTP turned on in the console', async () => {
  // An appliance that starts accepting unencrypted AI traffic is exactly what
  // this check exists for.
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([{ ...liveInSync, ports: { http: { enable: true, port: 8080 }, https: { enable: true, port: 443 } } }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([APPLIANCE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.ports.http')
    assert.ok(diff, `expected an http ports diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'enable=false,port=80')
    assert.equal(diff.actual, 'enable=true,port=8080')
  } finally {
    restore()
  }
})

test('aig-appliances driftDetect: reports a capacity pack changed in the console', async () => {
  // Capacity packs are billed, so a pack swapped or resized is a cost change.
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([{ ...liveInSync, sku_addons: [{ product_code: 'NK-A-AIGW-100K', quantity: 5 }] }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([APPLIANCE]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.sku_addons')
    assert.ok(diff, `expected a sku_addons diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'NK-A-AIGW-10K:2')
    assert.equal(diff.actual, 'NK-A-AIGW-100K:5')
  } finally {
    restore()
  }
})

test('aig-appliances driftDetect: reports an AI provider detached in the console', async () => {
  const { restore } = routeFetch([{ url: BASE_RE, method: 'GET', respond: list([{ ...liveInSync, ai_provider_ids: [] }]) }])
  try {
    const result = await driftDetect(driftContext([APPLIANCE]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.ai_provider_ids')
    assert.ok(diff, `expected a provider diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '1')
    assert.equal(diff.actual, '0')
  } finally {
    restore()
  }
})

test('aig-appliances driftDetect: an AI provider SWAPPED for another is not reported', async () => {
  // Documented limitation, not an accident: the canvas holds names and the
  // tenant holds ids, so only the count can be compared. An appliance repointed
  // at a different provider of the same count reads as in sync.
  const { restore } = routeFetch([{ url: BASE_RE, method: 'GET', respond: list([{ ...liveInSync, ai_provider_ids: ['99'] }]) }])
  try {
    const result = await driftDetect(driftContext([APPLIANCE]))

    assert.equal(result.hasDrift, false)
    assert.notEqual(result.checked, false, 'it did look — the comparison is just coarser than the data')
  } finally {
    restore()
  }
})
