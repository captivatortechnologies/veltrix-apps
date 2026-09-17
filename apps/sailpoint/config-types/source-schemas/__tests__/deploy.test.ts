// deploy for ISC source schemas.
//
// The schema decides which account attribute correlates to an identity. Changing
// `identityAttribute` re-correlates every account the next aggregation sees, so
// the prior schema recorded for rollback is the only way back — and the update is
// a whole-body PUT, which drops anything the body omits.

import assert from 'node:assert/strict'
import { registerNestedDeployContract } from '../../../lib/__tests__/nestedContracts'
import deploy from '../deploy'
import {
  CHILD_PATH,
  PRIOR,
  SCHEMA_ID,
  SCHEMA_NAME,
  SOURCE_ID,
  SOURCE_NAME,
  liveSchema,
  parentSource,
  schemaItem,
} from './fixtures'

registerNestedDeployContract({
  label: 'source-schemas',
  handler: deploy,
  parentListPath: '/v3/sources',
  parent: parentSource(),
  childPath: CHILD_PATH,
  item: schemaItem(),
  live: liveSchema(),
  updateMethod: 'PUT',
  updatePath: `${CHILD_PATH}/${SCHEMA_ID}`,
  createBodyIncludes: ['"name":"account"', 'sAMAccountName', 'displayName'],
  updateBodyIncludes: ['sAMAccountName', 'displayName'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.schemaId, 'created-1')
    assert.equal(entry.sourceId, SOURCE_ID, 'the entry must carry the source id rollback needs')
    assert.equal(entry.schemaName, SCHEMA_NAME)
  },
  assertPrior: (entry) => {
    assert.equal(entry.schemaId, SCHEMA_ID)
    assert.equal(entry.sourceId, SOURCE_ID)
    assert.deepEqual(entry.prior, PRIOR)
  },
  parentMissingMatch: /source "Active Directory" not found/,
  childListFailureMatch: /failed to list schemas/,
  reconcile: {
    priorEntry: {
      sourceName: SOURCE_NAME,
      sourceId: SOURCE_ID,
      schemaName: 'group',
      existed: false,
      schemaId: 'sch-retired',
    },
    deletePath: `${CHILD_PATH}/sch-retired`,
  },
})
