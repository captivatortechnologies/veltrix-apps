// rollback for device-classification-tags.
//
// The shared contracts cover the refusals and the restore/delete/404/error
// paths; the restore body is the prior name and description deploy captured.

import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

registerRollbackGuardContract({ label: 'device-classification-tags', handler: rollback })

registerCrudRollbackContract({
  label: 'device-classification-tags',
  handler: rollback,
  basePath: '/deviceclassification/tags',
  updateMethod: 'PUT',
  prior: { name: 'veltrix-alpha', description: 'edited in the console' },
  assertRestoreBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.description, 'edited in the console', 'the restore writes back what deploy found')
  },
})
