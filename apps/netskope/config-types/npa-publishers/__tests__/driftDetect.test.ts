// driftDetect for npa-publishers.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here: the broker-connect toggle,
// and that drift reads the NPA `{data: {publishers}}` envelope rather than a
// bare array — a handler reading the wrong shape sees an empty tenant and
// reports every publisher as deleted.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, npaList, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/infrastructure\/publishers/
const PUBLISHER = item('veltrix-alpha', { name: 'veltrix-alpha', lbrokerconnect: true })

registerDriftContract({
  label: 'npa-publishers',
  handler: driftDetect,
  basePath: '/infrastructure/publishers',
  listKey: 'publishers',
  items: [PUBLISHER],
  inSync: [{ publisher_id: '4102', publisher_name: 'veltrix-alpha', lbrokerconnect: true }],
  missingField: 'veltrix-alpha',
})

test('npa-publishers driftDetect: reports local-broker connect turned off in the console', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('publishers', [{ publisher_id: '4102', publisher_name: 'veltrix-alpha', lbrokerconnect: false }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([PUBLISHER]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.lbrokerconnect')
    assert.ok(diff, `expected an lbrokerconnect diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
  } finally {
    restore()
  }
})

test('npa-publishers driftDetect: treats a missing lbrokerconnect as off, not as unknown', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('publishers', [{ publisher_id: '4102', publisher_name: 'veltrix-alpha' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([PUBLISHER]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].actual, 'false')
  } finally {
    restore()
  }
})
