// driftDetect for aig-token-groups — the shared contract plus the description
// comparison, which is the only managed field beyond the group's identity.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/aig\/tokengroups/
const GROUP = item('veltrix-alpha', { name: 'veltrix-alpha', description: 'Managed by Veltrix' })

registerDriftContract({
  label: 'aig-token-groups',
  handler: driftDetect,
  basePath: '/aig/tokengroups',
  items: [GROUP],
  inSync: [{ id: '4102', name: 'veltrix-alpha', description: 'Managed by Veltrix' }],
  missingField: 'veltrix-alpha',
})

test('aig-token-groups driftDetect: reports a description changed in the tenant', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([{ id: '4102', name: 'veltrix-alpha', description: 'edited in the console' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'Managed by Veltrix')
    assert.equal(diff.actual, 'edited in the console')
  } finally {
    restore()
  }
})
