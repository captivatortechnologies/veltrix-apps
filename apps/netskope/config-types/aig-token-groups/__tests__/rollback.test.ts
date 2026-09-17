// rollback for aig-token-groups — the shared refusals plus the restore/delete
// paths. The restore body is the prior name and description deploy captured.

import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

registerRollbackGuardContract({ label: 'aig-token-groups', handler: rollback })

registerCrudRollbackContract({
  label: 'aig-token-groups',
  handler: rollback,
  basePath: '/aig/tokengroups',
  updateMethod: 'PUT',
  prior: { name: 'veltrix-alpha', description: 'edited in the console' },
  assertRestoreBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.description, 'edited in the console')
  },
})
