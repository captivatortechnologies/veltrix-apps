// driftDetect for npa-local-brokers.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here is the reachability mode,
// which decides how NPA traffic reaches the broker.
//
// NOTE: the custom private/public IPs, the labels and the geo fields are
// deliberately not asserted. The handler does not diff them, so a broker
// readdressed in the console reports as in sync — see the report accompanying
// these tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, npaList, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/infrastructure\/lbrokers/
const BROKER = item('veltrix-alpha', {
  local_broker_name: 'veltrix-alpha',
  access_via_public_ip: 'ON_PREM',
  custom_private_ip: '10.10.0.5',
})

registerDriftContract({
  label: 'npa-local-brokers',
  handler: driftDetect,
  basePath: '/infrastructure/lbrokers',
  listKey: 'lbrokers',
  items: [BROKER],
  inSync: [{ local_broker_id: '4102', local_broker_name: 'veltrix-alpha', access_via_public_ip: 'ON_PREM' }],
  missingField: 'veltrix-alpha',
})

test('npa-local-brokers driftDetect: reports the reachability mode changed in the console', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('lbrokers', [
        { local_broker_id: '4102', local_broker_name: 'veltrix-alpha', access_via_public_ip: 'ON_OFF_PREM' },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([BROKER]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.access_via_public_ip')
    assert.ok(diff, `expected an access_via_public_ip diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'ON_PREM')
    assert.equal(diff.actual, 'ON_OFF_PREM')
  } finally {
    restore()
  }
})

test('npa-local-brokers driftDetect: treats an omitted reachability mode as NONE', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('lbrokers', [{ local_broker_id: '4102', local_broker_name: 'veltrix-alpha' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([BROKER]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].actual, 'NONE')
  } finally {
    restore()
  }
})
