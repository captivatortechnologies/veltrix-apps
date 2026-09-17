// ============================================================================
// deploy for ISC verified from-addresses.
//
// This is the one configuration type with no update path at all: an address is
// either already registered — in which case deploy records it and writes nothing,
// leaving the out-of-band verification alone — or it is registered for the first
// time. The distinction matters because the `existed` flag it records is the only
// thing stopping rollback from deleting an address the tenant already had.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsWithMethod,
  created,
  deployContext,
  iscError,
  leaksSecret,
  listPage,
  pathOf,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeIsc'
import { MISSING_CREDENTIAL_MESSAGE } from '../../../lib/isc'
import deploy from '../deploy'
import { BASE, EMAIL, LIVE_ID, addressItem, liveAddress } from './fixtures'

type Entries = Array<Record<string, unknown>>

function entriesOf(result: { rollbackData?: unknown }): Entries {
  return ((result.rollbackData as { entries?: Entries } | undefined)?.entries ?? []) as Entries
}

test('verified-from-addresses deploy: refuses without a credential instead of calling ISC', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([addressItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.equal(result.message, MISSING_CREDENTIAL_MESSAGE)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('verified-from-addresses deploy: refuses when the tenant setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([addressItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('verified-from-addresses deploy: a failed listing stops the deploy before it writes', async () => {
  const { calls, restore } = recordFetch([TOKEN, iscError(500, 'upstream failure')])
  try {
    const result = await deploy(deployContext([addressItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /Failed to list/i)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('verified-from-addresses deploy: registers an address the tenant does not have', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([]), created({ id: 'vfa-new', email: EMAIL })])
  try {
    const result = await deploy(deployContext([addressItem()]))

    assert.equal(result.success, true, result.message)
    const iscCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(pathOf(iscCalls[0]).startsWith(BASE))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'POST')
    assert.equal(pathOf(writes[0]), BASE)
    assert.deepEqual(bodyOf(writes[0]), { email: EMAIL })

    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, false, 'an address this deploy registered must be recorded as new')
    assert.equal(entries[0].id, 'vfa-new')
  } finally {
    restore()
  }
})

test('verified-from-addresses deploy: records an already-registered address without writing', async () => {
  // Re-posting a registered address would restart its verification. There is
  // nothing to update here, so the correct number of writes is zero.
  const { calls, restore } = recordFetch([TOKEN, listPage([liveAddress()])])
  try {
    const result = await deploy(deployContext([addressItem()]))

    assert.equal(result.success, true, result.message)
    assert.equal(writeCalls(calls).length, 0, 'an address that already exists must not be re-registered')

    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true, 'a pre-existing address must be recorded as pre-existing')
    assert.equal(entries[0].id, LIVE_ID)
  } finally {
    restore()
  }
})

test('verified-from-addresses deploy: matches a registered address case-insensitively', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([liveAddress({ email: EMAIL.toUpperCase() })])])
  try {
    const result = await deploy(deployContext([addressItem()]))

    assert.equal(result.success, true, result.message)
    assert.equal(writeCalls(calls).length, 0, 'a differently-cased address is the same address')
  } finally {
    restore()
  }
})

test('verified-from-addresses deploy: reports a rejected registration rather than throwing', async () => {
  const { restore } = recordFetch([TOKEN, listPage([]), iscError(400, 'the domain is not permitted')])
  try {
    const result = await deploy(deployContext([addressItem()]))

    assert.equal(result.success, false)
    assert.ok(result.message.includes('the domain is not permitted'), result.message)
    assert.ok(result.rollbackData)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('verified-from-addresses deploy: deletes an address it registered and no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([]), created({ id: 'vfa-new' }), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([addressItem()], {
        priorRollbackData: { entries: [{ email: 'retired@acme.example', existed: false, id: 'vfa-retired' }] },
      }),
    )

    assert.equal(result.success, true, result.message)
    const deletes = callsWithMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1)
    assert.equal(pathOf(deletes[0]), `${BASE}/vfa-retired`)
  } finally {
    restore()
  }
})

test('verified-from-addresses deploy: never deletes an address it did not register', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([]), created({ id: 'vfa-new' })])
  try {
    await deploy(
      deployContext([addressItem()], {
        priorRollbackData: { entries: [{ email: 'preexisting@acme.example', existed: true, id: 'vfa-theirs' }] },
      }),
    )

    assert.equal(callsWithMethod(calls, 'DELETE').length, 0, 'an address the tenant already had must be left alone')
  } finally {
    restore()
  }
})
