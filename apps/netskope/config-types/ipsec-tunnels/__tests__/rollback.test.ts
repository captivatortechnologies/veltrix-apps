// rollback for ipsec-tunnels.
//
// The shared contracts cover the refusals and the restore/delete paths. What is
// specific here: the pre-shared key is write-only and was therefore never
// recorded, so the restore CANNOT carry one — and must not invent one, which
// would replace a working site-to-site key with a value nobody configured.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/steering\/ipsec\/tunnels/
const PRIOR = {
  site: 'london-dc',
  source_ip: '198.51.100.7',
  pop_names: ['EU-West'],
  encryption: 'AES128',
  bandwidth: 10,
  enabled: false,
  notes: 'edited in the console',
  options: { reauth: false, rekey: false, xff: { enabled: false, iplist: [] } },
}

registerRollbackGuardContract({ label: 'ipsec-tunnels', handler: rollback, nameKey: 'site' })

registerCrudRollbackContract({
  label: 'ipsec-tunnels',
  handler: rollback,
  basePath: '/steering/ipsec/tunnels',
  updateMethod: 'PUT',
  nameKey: 'site',
  prior: PRIOR,
  assertRestoreBody: (body) => {
    assert.equal(body.source_ip, '198.51.100.7')
    assert.equal(body.encryption, 'AES128')
    assert.equal(body.enabled, false)
  },
})

test('ipsec-tunnels rollback: sends no psk, because the API never returned one to record', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: ok({ tunnel_id: '4102' }) }])
  try {
    await rollback(rollbackContext({ entries: [{ site: 'london-dc', existed: true, id: '4102', prior: PRIOR }] }))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal(
      'psk' in body,
      false,
      'a made-up PSK here would break the tunnel it is supposed to be restoring',
    )
    assert.deepEqual(body, PRIOR, 'the restore is the recorded snapshot and nothing else')
  } finally {
    restore()
  }
})
