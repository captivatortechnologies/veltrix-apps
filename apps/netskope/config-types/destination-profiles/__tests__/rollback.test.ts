// rollback for destination-profiles — the shared refusals plus the
// restore/delete paths. The restore puts back the match type, the network set
// and the label ids the tenant held, all of which policies match on.

import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

registerRollbackGuardContract({ label: 'destination-profiles', handler: rollback })

registerCrudRollbackContract({
  label: 'destination-profiles',
  handler: rollback,
  basePath: '/profiles/destinations',
  updateMethod: 'PATCH',
  prior: {
    name: 'veltrix-alpha',
    type: 'insensitive',
    description: 'edited in the console',
    values: ['192.168.0.0/16'],
    label_ids: ['33'],
  },
  assertRestoreBody: (body) => {
    assert.equal(body.type, 'insensitive')
    assert.deepEqual(body.values, ['192.168.0.0/16'], 'the restore puts back the network set deploy overwrote')
    assert.deepEqual(body.label_ids, ['33'])
  },
})
