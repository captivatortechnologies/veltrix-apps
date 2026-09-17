// rollback for custom-categories — the shared refusals plus the restore/delete
// paths. The restore puts back all five membership lists the tenant held, so a
// category the deploy widened or narrowed returns to exactly what it matched
// before.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/profiles\/customcategories/
const PRIOR = {
  name: 'veltrix-alpha',
  description: 'edited in the console',
  included_predefined_categories: ['600', '601'],
  included_url_lists: ['11'],
  excluded_url_lists: [],
  included_destination_profiles: [],
  excluded_destination_profiles: ['22'],
}

registerRollbackGuardContract({ label: 'custom-categories', handler: rollback })

registerCrudRollbackContract({
  label: 'custom-categories',
  handler: rollback,
  basePath: '/profiles/customcategories',
  updateMethod: 'PATCH',
  prior: PRIOR,
  assertRestoreBody: (body) => {
    assert.deepEqual(body.included_predefined_categories, ['600', '601'])
    assert.deepEqual(body.included_url_lists, ['11'])
    assert.deepEqual(body.excluded_destination_profiles, ['22'])
  },
})

test('custom-categories rollback: restores every membership list, emptied ones included', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PATCH', respond: ok({ id: '4102' }) }])
  try {
    await rollback(rollbackContext({ entries: [{ name: 'veltrix-alpha', existed: true, id: '4102', prior: PRIOR }] }))

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        'description',
        'excluded_destination_profiles',
        'excluded_url_lists',
        'included_destination_profiles',
        'included_predefined_categories',
        'included_url_lists',
        'name',
      ],
      'a membership list left out of the restore is one the rollback never puts back',
    )
    assert.deepEqual(body.excluded_url_lists, [])
    assert.deepEqual(body.included_destination_profiles, [])
  } finally {
    restore()
  }
})
