// rollback for gre-tunnels — the shared refusals plus the restore/delete paths.
// Tunnel entries are keyed on `site`, not `name`. The restore sends the recorded
// snapshot verbatim, so a tunnel comes back on the source IP, bandwidth and
// enabled state the tenant had before the deploy.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/steering\/gre\/tunnels/
const PRIOR = {
  site: 'london-dc',
  source_ip: '198.51.100.7',
  pop_names: ['US-East'],
  bandwidth: 250,
  enabled: false,
  notes: 'edited in the console',
  options: { xff: { xff_enabled: false, xff_ip_list: [] } },
}

registerRollbackGuardContract({ label: 'gre-tunnels', handler: rollback, nameKey: 'site' })

registerCrudRollbackContract({
  label: 'gre-tunnels',
  handler: rollback,
  basePath: '/steering/gre/tunnels',
  updateMethod: 'PUT',
  nameKey: 'site',
  prior: PRIOR,
  assertRestoreBody: (body) => {
    assert.equal(body.source_ip, '198.51.100.7')
    assert.equal(body.bandwidth, 250)
    assert.equal(body.enabled, false, 'a tunnel that was disabled must not come back up')
  },
})

test('gre-tunnels rollback: sends the recorded snapshot verbatim', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: ok({ tunnel_id: '4102' }) }])
  try {
    await rollback(rollbackContext({ entries: [{ site: 'london-dc', existed: true, id: '4102', prior: PRIOR }] }))

    assert.deepEqual(
      bodyOf(writeCalls(calls)[0]),
      PRIOR,
      'a replacing PUT must carry the whole prior spec, including the nested XFF options',
    )
  } finally {
    restore()
  }
})
