// deploy for ISC identity attributes.
//
// An identity attribute is part of how every identity is built, so the update is a
// whole-body PUT keyed by the technical name. Standard and system attributes belong
// to SailPoint and must never be written; the app only owns custom ones.

import assert from 'node:assert/strict'
import test from 'node:test'
import { TOKEN, deployContext, listPage, recordFetch, writeCalls } from '../../../lib/__tests__/fakeIsc'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { NAME, PRIOR, attributeItem, liveIdentityAttribute } from './fixtures'

registerCollectionDeployContract({
  label: 'identity-attributes',
  handler: deploy,
  listPath: '/beta/identity-attributes',
  createPath: '/beta/identity-attributes',
  updatePath: '/beta/identity-attributes/costCenter',
  updateMethod: 'PUT',
  item: attributeItem(),
  live: liveIdentityAttribute(),
  createBodyIncludes: ['costCenter', 'Cost Centre', '"searchable":true'],
  updateBodyIncludes: ['Cost Centre', 'Cost Centre Rule', '"searchable":true'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.name, NAME)
  },
  assertPrior: (entry) => {
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'retiredAttribute', existed: false },
    deletePath: '/beta/identity-attributes/retiredAttribute',
  },
})

test('identity-attributes deploy: refuses to modify a standard or system attribute', async () => {
  // Standard and system attributes are SailPoint's. Overwriting one changes how
  // every identity in the tenant is built.
  for (const flags of [{ standard: true }, { system: true }]) {
    const { calls, restore } = recordFetch([TOKEN, listPage([liveIdentityAttribute(flags)])])
    try {
      const result = await deploy(deployContext([attributeItem()]))

      assert.equal(result.success, false)
      assert.match(result.message, /standard\/system identity attribute/)
      assert.equal(writeCalls(calls).length, 0, 'a protected attribute must not be written at all')
    } finally {
      restore()
    }
  }
})
