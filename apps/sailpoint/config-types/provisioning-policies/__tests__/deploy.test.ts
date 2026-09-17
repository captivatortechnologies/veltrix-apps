// deploy for ISC provisioning policies.
//
// A provisioning policy is the attribute map used when accounts are created or
// updated on a source, so replacing its `fields` changes what actually gets
// written into the directory. The update is a whole-body PUT addressed by usage
// type — there is no id — which makes the prior body the only way back.

import assert from 'node:assert/strict'
import { registerNestedDeployContract } from '../../../lib/__tests__/nestedContracts'
import deploy from '../deploy'
import {
  CHILD_PATH,
  PRIOR,
  SOURCE_ID,
  SOURCE_NAME,
  USAGE_TYPE,
  livePolicy,
  parentSource,
  policyItem,
} from './fixtures'

registerNestedDeployContract({
  label: 'provisioning-policies',
  handler: deploy,
  parentListPath: '/v3/sources',
  parent: parentSource(),
  childPath: CHILD_PATH,
  item: policyItem(),
  live: livePolicy(),
  updateMethod: 'PUT',
  updatePath: `${CHILD_PATH}/${USAGE_TYPE}`,
  createBodyIncludes: ['Create AD Account', 'sAMAccountName', '"usageType":"CREATE"'],
  updateBodyIncludes: ['Create AD Account', 'sAMAccountName'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.usageType, USAGE_TYPE)
    assert.equal(entry.sourceId, SOURCE_ID, 'the entry must carry the source id rollback needs')
    assert.equal(entry.sourceName, SOURCE_NAME)
  },
  assertPrior: (entry) => {
    assert.equal(entry.usageType, USAGE_TYPE)
    assert.equal(entry.sourceId, SOURCE_ID)
    assert.deepEqual(entry.prior, PRIOR)
  },
  parentMissingMatch: /source "Active Directory" not found/,
  childListFailureMatch: /failed to list provisioning policies/,
  reconcile: {
    priorEntry: { sourceName: SOURCE_NAME, sourceId: SOURCE_ID, usageType: 'UPDATE', existed: false },
    deletePath: `${CHILD_PATH}/UPDATE`,
  },
})
