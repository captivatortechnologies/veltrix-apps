// deploy for ISC transforms.
//
// A transform feeds identity attribute mappings, so replacing one changes what every
// identity built from it looks like. The update is a whole-body PUT; a SailPoint
// internal transform of the same name must never be written, and the type is
// immutable.

import assert from 'node:assert/strict'
import test from 'node:test'
import { TOKEN, deployContext, listPage, recordFetch, writeCalls } from '../../../lib/__tests__/fakeIsc'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveTransform, transformItem } from './fixtures'

registerCollectionDeployContract({
  label: 'transforms',
  handler: deploy,
  listPath: '/transforms/v1',
  createPath: '/transforms/v1',
  updatePath: '/transforms/v1/tf-5f9022',
  updateMethod: 'PUT',
  item: transformItem(),
  live: liveTransform(),
  createBodyIncludes: ['Upper Case Email', '"type":"upper"', 'accountAttribute'],
  updateBodyIncludes: ['accountAttribute', 'attributeName'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Transform', existed: false, id: 'tf-retired' },
    deletePath: '/transforms/v1/tf-retired',
  },
})

test('transforms deploy: never writes a SailPoint-internal transform', async () => {
  // Internal transforms are shipped by SailPoint and used by the product itself.
  const { calls, restore } = recordFetch([TOKEN, listPage([liveTransform({ internal: true })])])
  try {
    const result = await deploy(deployContext([transformItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /internal\) transform/)
    assert.equal(writeCalls(calls).length, 0, 'an internal transform must not be written at all')
  } finally {
    restore()
  }
})

test('transforms deploy: refuses when it cannot tell whether the transform is internal', async () => {
  // `if (liveMatch.internal)` read an absent flag as "not internal", so a
  // listing that omitted it let the PUT overwrite a transform SailPoint ships
  // and the product itself uses.
  const { calls, restore } = recordFetch([TOKEN, listPage([liveTransform({ internal: undefined })])])
  try {
    const result = await deploy(deployContext([transformItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /could not confirm/)
    assert.equal(writeCalls(calls).length, 0, 'unknown must mean protected, not unprotected')
  } finally {
    restore()
  }
})

test('transforms deploy: refuses to change an existing transform\'s type', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([liveTransform({ type: 'lower' })])])
  try {
    const result = await deploy(deployContext([transformItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /type is immutable/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})
