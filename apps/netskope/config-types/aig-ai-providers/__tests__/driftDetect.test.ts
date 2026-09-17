// driftDetect for aig-ai-providers.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here: the four scalar fields that
// steer AI traffic, and that the write-only certificate never reaches a diff.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, leaks, list, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/aig\/aiproviders/
const CERTIFICATE = '-----BEGIN CERTIFICATE-----MUST-NOT-BE-STORED-----END CERTIFICATE-----'
const PROVIDER = item('veltrix-alpha', {
  name: 'veltrix-alpha',
  schema: 'openai',
  host: 'api.openai.test',
  port: 443,
  protocol: 'https',
  certificate: CERTIFICATE,
})

registerDriftContract({
  label: 'aig-ai-providers',
  handler: driftDetect,
  basePath: '/aig/aiproviders',
  items: [PROVIDER],
  inSync: [{ provider_id: '4102', name: 'veltrix-alpha', schema: 'openai', host: 'api.openai.test', port: 443, protocol: 'https' }],
  missingField: 'veltrix-alpha',
})

test('aig-ai-providers driftDetect: reports a provider repointed at a different host', async () => {
  // This is the case drift detection exists to catch: AI traffic silently
  // redirected to somebody else's endpoint.
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([
        { provider_id: '4102', name: 'veltrix-alpha', schema: 'openai', host: 'attacker.example', port: 443, protocol: 'https' },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([PROVIDER]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.host')
    assert.ok(diff, `expected a host diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'api.openai.test')
    assert.equal(diff.actual, 'attacker.example')
  } finally {
    restore()
  }
})

test('aig-ai-providers driftDetect: reports port, protocol and schema changes, and leaks no certificate', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([
        { provider_id: '4102', name: 'veltrix-alpha', schema: 'anthropic', host: 'api.openai.test', port: 8080, protocol: 'http' },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([PROVIDER]))

    const fields = result.diffs.map((d) => d.field)
    assert.deepEqual(fields.sort(), ['veltrix-alpha.port', 'veltrix-alpha.protocol', 'veltrix-alpha.schema'])
    assert.equal(leaks(result, CERTIFICATE), false, 'the write-only certificate must never appear in a diff')
  } finally {
    restore()
  }
})
