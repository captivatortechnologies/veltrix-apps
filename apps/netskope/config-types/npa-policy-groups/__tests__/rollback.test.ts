// rollback for npa-policy-groups — the shared refusals plus the restore/delete
// paths. The only managed field is the group name, so the restore puts back the
// name the tenant held before the deploy renamed it.

import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

registerRollbackGuardContract({ label: 'npa-policy-groups', handler: rollback })

registerCrudRollbackContract({
  label: 'npa-policy-groups',
  handler: rollback,
  basePath: '/policy/npa/policygroups',
  updateMethod: 'PUT',
  prior: { name: 'VELTRIX-ALPHA' },
  assertRestoreBody: (body) => {
    assert.deepEqual(body, { group_name: 'VELTRIX-ALPHA' }, 'the restore writes back the name deploy found')
  },
})
