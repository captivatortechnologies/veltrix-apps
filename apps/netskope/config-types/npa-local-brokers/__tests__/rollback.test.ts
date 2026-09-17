// rollback for npa-local-brokers — the shared refusals plus the restore/delete
// paths. The restore sends the recorded snapshot verbatim, so a broker comes
// back on the reachability mode and addresses the tenant had before the deploy.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/infrastructure\/lbrokers/
const PRIOR = {
  local_broker_name: 'veltrix-alpha',
  access_via_public_ip: 'OFF_PREM',
  custom_private_ip: '10.99.0.9',
  custom_public_ip: '198.51.100.20',
  label_ids: ['33'],
  city_name: 'Manchester',
  region_name: '',
  country_name: '',
  country_code: 'GB',
}

registerRollbackGuardContract({ label: 'npa-local-brokers', handler: rollback })

registerCrudRollbackContract({
  label: 'npa-local-brokers',
  handler: rollback,
  basePath: '/infrastructure/lbrokers',
  updateMethod: 'PUT',
  prior: PRIOR,
  assertRestoreBody: (body) => {
    assert.equal(body.access_via_public_ip, 'OFF_PREM', 'the restore puts back the reachability mode deploy changed')
    assert.equal(body.custom_private_ip, '10.99.0.9')
    assert.deepEqual(body.label_ids, ['33'])
  },
})

test('npa-local-brokers rollback: sends the recorded snapshot verbatim', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: ok({ local_broker_id: '4102' }) }])
  try {
    await rollback(rollbackContext({ entries: [{ name: 'veltrix-alpha', existed: true, id: '4102', prior: PRIOR }] }))

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), PRIOR)
  } finally {
    restore()
  }
})
