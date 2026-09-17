// deploy for ISC password policies.
//
// The update is a whole-body PUT that merges the managed rule fields over whatever
// the tenant had, so the unmanaged fields (sourceIds, defaultPolicy) must survive
// it. The tenant default policy is protected and must never be written at all.

import assert from 'node:assert/strict'
import test from 'node:test'
import { TOKEN, bodyOf, deployContext, listPage, ok, recordFetch, writeCalls } from '../../../lib/__tests__/fakeIsc'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, livePasswordPolicy, policyItem } from './fixtures'

registerCollectionDeployContract({
  label: 'password-policies',
  handler: deploy,
  listPath: '/v3/password-policies',
  createPath: '/v3/password-policies',
  updatePath: '/v3/password-policies/pp-77e2',
  updateMethod: 'PUT',
  item: policyItem(),
  live: livePasswordPolicy(),
  createBodyIncludes: ['Privileged Account Policy', '"minLength":16', 'Rules for privileged accounts'],
  updateBodyIncludes: ['"minLength":16', '"src-ad"'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Policy', existed: false, id: 'pp-retired' },
    deletePath: '/v3/password-policies/pp-retired',
  },
})

test('password-policies deploy: never writes the tenant default policy', async () => {
  // The default policy governs every account with no policy of its own.
  const { calls, restore } = recordFetch([TOKEN, listPage([livePasswordPolicy({ defaultPolicy: true })])])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /tenant default password policy/)
    assert.equal(writeCalls(calls).length, 0, 'the default policy must not be written at all')
  } finally {
    restore()
  }
})

test('password-policies deploy: the update preserves fields the app does not manage', async () => {
  // A whole-body PUT drops anything it omits — sourceIds decides which sources
  // the policy governs, and nothing in the canvas declares it.
  const { calls, restore } = recordFetch([TOKEN, listPage([livePasswordPolicy()]), ok({})])
  try {
    await deploy(deployContext([policyItem()]))

    const body = bodyOf(writeCalls(calls)[0]) as Record<string, unknown>
    assert.deepEqual(body.sourceIds, ['src-ad'], 'the PUT dropped an unmanaged field')
    assert.equal(body.minLength, 16)
    assert.equal(body.lastUpdated, undefined, 'read-only timestamps must not be sent back')
  } finally {
    restore()
  }
})
