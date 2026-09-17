// deploy for ISC connector rules.
//
// The update is a whole-body PUT, which means anything missing from the body is
// gone. The rule `type` is immutable — a same-named rule of another type has to be
// refused rather than replaced, because replacing it changes where the code runs.

import assert from 'node:assert/strict'
import test from 'node:test'
import { TOKEN, deployContext, listPage, recordFetch, writeCalls } from '../../../lib/__tests__/fakeIsc'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveConnectorRule, ruleItem } from './fixtures'

registerCollectionDeployContract({
  label: 'connector-rules',
  handler: deploy,
  listPath: '/beta/connector-rules',
  createPath: '/beta/connector-rules',
  updatePath: '/beta/connector-rules/cr-19ab55',
  updateMethod: 'PUT',
  item: ruleItem(),
  live: liveConnectorRule(),
  createBodyIncludes: ['Build Map Normalizer', 'BuildMap', 'normalised'],
  updateBodyIncludes: ['BuildMap', 'Normalise account attributes during aggregation', 'normalised'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Rule', existed: false, id: 'cr-retired' },
    deletePath: '/beta/connector-rules/cr-retired',
  },
})

test('connector-rules deploy: refuses to overwrite a same-named rule of another type', async () => {
  // The rule type decides where the code runs. Overwriting a WebService rule with
  // a BuildMap body would silently move the script to a different hook.
  const { calls, restore } = recordFetch([
    TOKEN,
    listPage([liveConnectorRule({ type: 'WebServiceBeforeOperationRule' })]),
  ])
  try {
    const result = await deploy(deployContext([ruleItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /type is immutable/)
    assert.equal(writeCalls(calls).length, 0, 'a refused type change must not write anything')
  } finally {
    restore()
  }
})
