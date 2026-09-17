// rollback for publisher-upgrade-profiles — the shared refusals plus the
// restore/delete paths. The restore puts back the build, channel, schedule and
// enabled flag the tenant held before the deploy.

import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

registerRollbackGuardContract({ label: 'publisher-upgrade-profiles', handler: rollback })

registerCrudRollbackContract({
  label: 'publisher-upgrade-profiles',
  handler: rollback,
  basePath: '/infrastructure/publisherupgradeprofiles',
  updateMethod: 'PUT',
  prior: {
    name: 'veltrix-alpha',
    docker_tag: '1.9.0',
    release_type: 'Beta',
    enabled: false,
    frequency: '30 4 * * MON',
    timezone: 'UTC',
    timezone_id: 1,
  },
  assertRestoreBody: (body) => {
    assert.equal(body.docker_tag, '1.9.0')
    assert.equal(body.release_type, 'Beta')
    assert.equal(body.enabled, false, 'a profile that was disabled must not come back enabled')
    assert.equal(body.frequency, '30 4 * * MON')
  },
})
