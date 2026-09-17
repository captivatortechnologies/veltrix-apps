// driftDetect for ipsec-tunnels.
//
// The shared contract covers the refusals, the "gone from the tenant" diff and
// the unreadable-tenant rule. What is specific here: the cipher, the source IP
// and the enabled state — a tunnel downgraded from AES256 to AES128 in the
// console is exactly the change drift detection exists to surface. Neither the
// PSK (write-only) nor the POP names (unreliable in list responses) are diffed.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, leaks, npaList, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/steering\/ipsec\/tunnels/
const PSK = 'pre-shared-key-MUST-NOT-BE-STORED'
const TUNNEL = item('london-dc', {
  site: 'london-dc',
  source_ip: '203.0.113.10',
  pop_names: 'EU-West',
  psk: PSK,
  encryption: 'AES256',
  enabled: true,
})

registerDriftContract({
  label: 'ipsec-tunnels',
  handler: driftDetect,
  basePath: '/steering/ipsec/tunnels',
  listKey: 'tunnels',
  items: [TUNNEL],
  inSync: [{ tunnel_id: '4102', site: 'london-dc', source_ip: '203.0.113.10', encryption: 'AES256', enabled: true }],
  missingField: 'london-dc',
})

test('ipsec-tunnels driftDetect: reports a cipher downgraded in the console', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('tunnels', [
        { tunnel_id: '4102', site: 'london-dc', source_ip: '203.0.113.10', encryption: 'AES128', enabled: true },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([TUNNEL]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'london-dc.encryption')
    assert.ok(diff, `expected an encryption diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'AES256')
    assert.equal(diff.actual, 'AES128')
    assert.equal(leaks(result, PSK), false, 'the PSK must never appear in a diff')
  } finally {
    restore()
  }
})

test('ipsec-tunnels driftDetect: reports a tunnel disabled and repointed', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('tunnels', [
        { tunnel_id: '4102', site: 'london-dc', source_ip: '198.51.100.7', encryption: 'AES256', enabled: false },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([TUNNEL]))

    const fields = result.diffs.map((d) => d.field).sort()
    assert.deepEqual(fields, ['london-dc.enabled', 'london-dc.source_ip'])
    assert.equal(leaks(result, PSK), false)
  } finally {
    restore()
  }
})

test('ipsec-tunnels driftDetect: does not diff the cipher when the canvas declares none', async () => {
  // An undeclared cipher means "whatever the tenant negotiates" — reporting the
  // tenant's choice as drift would be a permanent false positive.
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('tunnels', [
        { tunnel_id: '4102', site: 'london-dc', source_ip: '203.0.113.10', encryption: 'AES128', enabled: true },
      ]),
    },
  ])
  try {
    const result = await driftDetect(
      driftContext([item('london-dc', { site: 'london-dc', source_ip: '203.0.113.10', enabled: true })]),
    )

    assert.equal(result.hasDrift, false, `an undeclared cipher is unmanaged: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
