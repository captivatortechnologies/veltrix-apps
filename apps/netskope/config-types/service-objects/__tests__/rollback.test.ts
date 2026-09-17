// rollback for service-objects.
//
// The shared contracts cover the refusals and the restore/delete paths. What is
// specific here: the restore rebuilds the body through the same builder deploy
// uses, so a protocol the object did NOT have before must not reappear as an
// empty key — and one it did have must come back in full.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/profiles\/serviceobjects/

registerRollbackGuardContract({ label: 'service-objects', handler: rollback })

registerCrudRollbackContract({
  label: 'service-objects',
  handler: rollback,
  basePath: '/profiles/serviceobjects',
  updateMethod: 'PATCH',
  prior: {
    name: 'veltrix-alpha',
    description: 'edited in the console',
    icmp: true,
    tcp: ['22', '443'],
    udp: ['53'],
    tcp_udp: [],
  },
  assertRestoreBody: (body) => {
    assert.equal(body.description, 'edited in the console')
    assert.deepEqual(body.protocols, { icmp: true, tcp: ['22', '443'], udp: ['53'] })
  },
})

test('service-objects rollback: does not add a protocol the object never had', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PATCH', respond: ok({ id: '4102' }) }])
  try {
    await rollback(
      rollbackContext({
        entries: [
          {
            name: 'veltrix-alpha',
            existed: true,
            id: '4102',
            prior: { name: 'veltrix-alpha', description: '', icmp: false, tcp: ['443'], udp: [], tcp_udp: [] },
          },
        ],
      }),
    )

    assert.deepEqual(
      bodyOf(writeCalls(calls)[0])?.protocols,
      { tcp: ['443'] },
      'an empty udp/tcp_udp list must not be sent as an opened protocol',
    )
  } finally {
    restore()
  }
})
