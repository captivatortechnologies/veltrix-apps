// rollback for npa-publishers — the shared refusals plus the restore/delete
// paths. The restore writes back the name and broker-connect setting the tenant
// held before the deploy.

import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

registerRollbackGuardContract({ label: 'npa-publishers', handler: rollback })

registerCrudRollbackContract({
  label: 'npa-publishers',
  handler: rollback,
  basePath: '/infrastructure/publishers',
  updateMethod: 'PATCH',
  prior: { name: 'veltrix-alpha', lbrokerconnect: false },
  assertRestoreBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.lbrokerconnect, false, 'the restore puts back the setting deploy found, not the one it wrote')
  },
})
