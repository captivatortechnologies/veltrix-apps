// rollback for dns-profiles — the shared refusals plus the restore/delete
// paths. The restore sends the recorded snapshot verbatim, including the nested
// config blobs exactly as the tenant held them.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/profiles\/dns/
const PRIOR = {
  name: 'veltrix-alpha',
  description: 'edited in the console',
  log_traffic: 'Blocked DNS',
  domain_config: { action: 'allow', materialised_default: true },
}

registerRollbackGuardContract({ label: 'dns-profiles', handler: rollback })

registerCrudRollbackContract({
  label: 'dns-profiles',
  handler: rollback,
  basePath: '/profiles/dns',
  updateMethod: 'PATCH',
  prior: PRIOR,
  assertRestoreBody: (body) => {
    assert.equal(body.log_traffic, 'Blocked DNS')
    assert.deepEqual(body.domain_config, { action: 'allow', materialised_default: true })
  },
})

test('dns-profiles rollback: sends the recorded snapshot verbatim', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PATCH', respond: ok({ profile_id: '4102' }) }])
  try {
    await rollback(rollbackContext({ entries: [{ name: 'veltrix-alpha', existed: true, id: '4102', prior: PRIOR }] }))

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), PRIOR)
  } finally {
    restore()
  }
})

test('dns-profiles rollback: restores a profile that had no config blobs without inventing any', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PATCH', respond: ok({ profile_id: '4102' }) }])
  try {
    await rollback(
      rollbackContext({
        entries: [
          {
            name: 'veltrix-alpha',
            existed: true,
            id: '4102',
            prior: { name: 'veltrix-alpha', description: '', log_traffic: 'Blocked DNS' },
          },
        ],
      }),
    )

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('domain_config' in body, false)
    assert.equal('tunnel_config' in body, false)
  } finally {
    restore()
  }
})
