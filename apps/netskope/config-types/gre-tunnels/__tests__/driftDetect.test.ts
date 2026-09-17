// driftDetect for gre-tunnels.
//
// The shared contract covers the refusals, the "gone from the tenant" diff and
// the unreadable-tenant rule. What is specific here: the source IP, the enabled
// state and the bandwidth allocation, plus the default-value handling — an
// `enabled` the tenant omits means enabled, and an omitted bandwidth means the
// 1000 Mbps default, so neither must read as drift on its own.
//
// POP names are deliberately not diffed: they drop out of list responses on some
// tenants, and a diff built on that reports every tunnel as having lost its POP.
// The handler documents this; the deploy re-sends them instead.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, npaList, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/steering\/gre\/tunnels/
const TUNNEL = item('london-dc', {
  site: 'london-dc',
  source_ip: '203.0.113.10',
  pop_names: 'US-East',
  bandwidth: 1000,
  enabled: true,
})

registerDriftContract({
  label: 'gre-tunnels',
  handler: driftDetect,
  basePath: '/steering/gre/tunnels',
  listKey: 'tunnels',
  items: [TUNNEL],
  inSync: [{ tunnel_id: '4102', site: 'london-dc', source_ip: '203.0.113.10', bandwidth: 1000, enabled: true }],
  missingField: 'london-dc',
})

test('gre-tunnels driftDetect: reports a tunnel repointed at a different source IP', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('tunnels', [{ tunnel_id: '4102', site: 'london-dc', source_ip: '198.51.100.7', bandwidth: 1000, enabled: true }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([TUNNEL]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'london-dc.source_ip')
    assert.ok(diff, `expected a source_ip diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '203.0.113.10')
    assert.equal(diff.actual, '198.51.100.7')
  } finally {
    restore()
  }
})

test('gre-tunnels driftDetect: reports a tunnel disabled and its bandwidth cut', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('tunnels', [{ tunnel_id: '4102', site: 'london-dc', source_ip: '203.0.113.10', bandwidth: 100, enabled: false }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([TUNNEL]))

    const fields = result.diffs.map((d) => d.field).sort()
    assert.deepEqual(fields, ['london-dc.bandwidth', 'london-dc.enabled'])
  } finally {
    restore()
  }
})

test('gre-tunnels driftDetect: treats an omitted enabled and bandwidth as the defaults, not as drift', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('tunnels', [{ tunnel_id: '4102', site: 'london-dc', source_ip: '203.0.113.10' }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([TUNNEL]))

    assert.equal(result.hasDrift, false, `defaults are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('gre-tunnels driftDetect: does not report POP names dropped from the list response', async () => {
  // Documented limitation: POP names are not returned reliably, so diffing them
  // would report every tunnel as having lost its POP on the tenants that omit
  // them.
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('tunnels', [{ tunnel_id: '4102', site: 'london-dc', source_ip: '203.0.113.10', bandwidth: 1000, enabled: true }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([TUNNEL]))

    assert.equal(result.hasDrift, false)
    assert.notEqual(result.checked, false, 'it did look — POP names are simply not comparable')
  } finally {
    restore()
  }
})
