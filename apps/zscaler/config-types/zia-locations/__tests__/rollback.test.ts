// rollback for zia-locations.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: a location's prior
// state is the WHOLE live object, so the restore replays it verbatim — including
// the server-managed fields the canvas never mentions — with only `name` and
// `id` forced, so the revert is an in-place edit and never a rename.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACTIVATED,
  NO_CONTENT,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  resourceCalls,
  rollbackContext,
  ziaError,
} from '../../../lib/__tests__/fakeZscaler'
import { registerRollbackGuardContract } from '../../../lib/__tests__/zscalerContracts'

registerRollbackGuardContract({
  label: 'zia-locations',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'HQ London',
  existed: true,
  id: 7788,
  prior: {
    id: 7788,
    name: 'HQ London',
    country: 'IRELAND',
    tz: 'EUROPE_DUBLIN',
    ipAddresses: ['198.51.100.7'],
    authRequired: false,
    sslScanEnabled: false,
    surrogateIP: true,
    profile: 'CORPORATE',
  },
}

const CREATED_ENTRY = { name: 'Branch Leeds', existed: false, id: 7789 }

test('zia-locations rollback: replays the whole prior object of a location deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 7788 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/locations\/7788$/)
    const body = bodyOf(tenant[0])
    assert.equal(body?.name, 'HQ London')
    assert.equal(body?.id, 7788, 'the id is forced so the revert edits in place')
    assert.equal(body?.country, 'IRELAND')
    assert.equal(body?.tz, 'EUROPE_DUBLIN')
    assert.deepEqual(body?.ipAddresses, ['198.51.100.7'])
    assert.equal(body?.authRequired, false)
    assert.equal(body?.sslScanEnabled, false)
    assert.equal(body?.surrogateIP, true, 'server-managed fields are replayed, not dropped')
    assert.equal(body?.profile, 'CORPORATE')

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-locations rollback: deletes a location deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/locations\/7789$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-locations rollback: undoes the newest change first', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({}), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, CREATED_ENTRY] }))

    assert.deepEqual(
      resourceCalls(calls).map((c) => c.method),
      ['DELETE', 'PUT'],
      'the later entry is reverted before the earlier one',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-locations rollback: a location already gone is not an error', async () => {
  // 404 is a known answer — the location we would delete is already absent,
  // which is the state rollback was trying to reach.
  const { restore } = recordFetch([TOKEN, notFound(), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back and activated 1/)
  } finally {
    restore()
  }
})

test('zia-locations rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Location has sub-locations that conflict')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Location has sub-locations that conflict/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-locations rollback: a failed activation is reported as still-staged', async () => {
  const { restore } = recordFetch([TOKEN, ok({}), ziaError(409, 'Another activation is already in progress')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /Re-run rollback/)
  } finally {
    restore()
  }
})
