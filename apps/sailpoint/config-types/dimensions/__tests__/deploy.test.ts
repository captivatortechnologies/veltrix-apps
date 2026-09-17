// deploy for ISC role dimensions.
//
// A dimension narrows a role for one population, so it carries its own bundle of
// access profiles and entitlements. It lives under a role that has to be resolved
// by name first, which gives deploy two ways to be wrong before it writes: a role
// it cannot find, and a child listing it could not read.

import assert from 'node:assert/strict'
import { registerNestedDeployContract } from '../../../lib/__tests__/nestedContracts'
import deploy from '../deploy'
import {
  CHILD_PATH,
  DIMENSION_ID,
  NAME,
  PRIOR,
  ROLE_ID,
  ROLE_NAME,
  dimensionItem,
  liveDimension,
  parentRole,
} from './fixtures'

registerNestedDeployContract({
  label: 'dimensions',
  handler: deploy,
  parentListPath: '/v3/roles',
  parent: parentRole(),
  childPath: CHILD_PATH,
  item: dimensionItem(),
  live: liveDimension(),
  updateMethod: 'PATCH',
  updatePath: `${CHILD_PATH}/${DIMENSION_ID}`,
  createBodyIncludes: [NAME, 'ap-emea-finance', 'ent-emea-ledger'],
  updateBodyIncludes: ['ap-emea-finance', 'id-owner-current'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.dimensionId, 'created-1')
    assert.equal(entry.roleId, ROLE_ID, 'the entry must carry the role id rollback needs')
    assert.equal(entry.roleName, ROLE_NAME)
  },
  assertPrior: (entry) => {
    assert.equal(entry.dimensionId, DIMENSION_ID)
    assert.equal(entry.roleId, ROLE_ID)
    assert.deepEqual(entry.prior, PRIOR)
  },
  parentMissingMatch: /role "Finance Analyst" not found/,
  childListFailureMatch: /failed to list dimensions/,
  reconcile: {
    priorEntry: {
      roleName: ROLE_NAME,
      roleId: ROLE_ID,
      name: 'Retired Dimension',
      existed: false,
      dimensionId: 'dim-retired',
    },
    deletePath: `${CHILD_PATH}/dim-retired`,
  },
})
