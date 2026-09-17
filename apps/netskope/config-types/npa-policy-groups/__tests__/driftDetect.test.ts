// driftDetect for npa-policy-groups.
//
// A group's only managed state is its existence under a name, so the shared
// contract carries nearly all of it. What is specific here is that a group
// deleted in the console — which takes every rule it contained out of the policy
// — is the critical case, and that it is matched case-insensitively.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, npaList, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/policy\/npa\/policygroups/
const GROUP = item('veltrix-alpha', { group_name: 'veltrix-alpha' })

registerDriftContract({
  label: 'npa-policy-groups',
  handler: driftDetect,
  basePath: '/policy/npa/policygroups',
  listKey: 'policy_groups',
  items: [GROUP],
  inSync: [{ id: '4102', group_name: 'veltrix-alpha' }],
  missingField: 'veltrix-alpha',
})

test('npa-policy-groups driftDetect: a group present under a different case is not drift', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('policy_groups', [{ id: '4102', group_name: 'VELTRIX-ALPHA' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, false, 'a case difference is not a deleted group')
  } finally {
    restore()
  }
})

test('npa-policy-groups driftDetect: reports only the group that is gone when several are declared', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaList('policy_groups', [{ id: '4102', group_name: 'veltrix-alpha' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([GROUP, item('veltrix-beta', { group_name: 'veltrix-beta' })]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs.length, 1)
    assert.equal(result.diffs[0].field, 'veltrix-beta')
    assert.equal(result.diffs[0].severity, 'critical')
  } finally {
    restore()
  }
})
