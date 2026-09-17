// rollback for aig-rate-limits — the shared refusals plus the restore/delete
// paths. The restore writes back the criteria, limit, appliance scope and
// response the tenant held before the deploy, not anything rebuilt from the
// canvas.

import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

registerRollbackGuardContract({ label: 'aig-rate-limits', handler: rollback })

registerCrudRollbackContract({
  label: 'aig-rate-limits',
  handler: rollback,
  basePath: '/aig/ratelimits',
  updateMethod: 'PUT',
  prior: {
    name: 'veltrix-alpha',
    criteria: { app: 'legacy' },
    limit: { requests: 10000, window: 'hour' },
    appliance_ids: ['appliance-west'],
    response: 'allow',
  },
  assertRestoreBody: (body) => {
    assert.deepEqual(body.criteria, { app: 'legacy' })
    assert.deepEqual(body.limit, { requests: 10000, window: 'hour' })
    assert.deepEqual(body.appliance_ids, ['appliance-west'])
    assert.equal(body.response, 'allow')
  },
})
