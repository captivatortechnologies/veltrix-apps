// deploy for ISC lifecycle states.
//
// A lifecycle state is what happens to someone's accounts when they change
// status — the `accountActions` list literally disables or enables accounts. The
// update replaces that list wholesale, so the prior list recorded for rollback is
// the only record of what the tenant was actually doing on a leaver.

import assert from 'node:assert/strict'
import { registerNestedDeployContract } from '../../../lib/__tests__/nestedContracts'
import deploy from '../deploy'
import {
  CHILD_PATH,
  PRIOR,
  PROFILE_ID,
  STATE_ID,
  TECHNICAL_NAME,
  liveState,
  parentProfile,
  stateItem,
} from './fixtures'

registerNestedDeployContract({
  label: 'lifecycle-states',
  handler: deploy,
  parentListPath: '/v3/identity-profiles',
  parent: parentProfile(),
  childPath: CHILD_PATH,
  item: stateItem(),
  live: liveState(),
  updateMethod: 'PATCH',
  updatePath: `${CHILD_PATH}/${STATE_ID}`,
  createBodyIncludes: [TECHNICAL_NAME, 'DISABLE', 'ap-offboarded'],
  updateBodyIncludes: ['DISABLE', 'ap-offboarded'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.stateId, 'created-1')
    assert.equal(entry.profileId, PROFILE_ID, 'the entry must carry the profile id rollback needs')
    assert.equal(entry.technicalName, TECHNICAL_NAME)
  },
  assertPrior: (entry) => {
    assert.equal(entry.stateId, STATE_ID)
    assert.equal(entry.profileId, PROFILE_ID)
    assert.deepEqual(entry.prior, PRIOR)
  },
  parentMissingMatch: /identity profile "Workday Employees" not found/,
  childListFailureMatch: /failed to list lifecycle states/,
  reconcile: {
    priorEntry: {
      profileName: 'Workday Employees',
      profileId: PROFILE_ID,
      technicalName: 'retiredState',
      existed: false,
      stateId: 'ls-retired',
    },
    deletePath: `${CHILD_PATH}/ls-retired`,
  },
})
