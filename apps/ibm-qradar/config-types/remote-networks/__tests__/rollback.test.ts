// rollback for remote-networks.
//
// The shared contract covers the refusals (no credential, no console host,
// nothing recorded). What is specific here: a network this deploy created is
// deleted, a network it only updated is POSTed back to the state deploy
// captured, and — because this type is staged — the undo is not live until
// `POST /staged_config/deploy_status` applies it.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  bodyOf,
  deployInProgress,
  leaksToken,
  notFound,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  rollbackContext,
  serverError,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/staged_config/remote_networks'
const DEPLOY_STATUS = '/staged_config/deploy_status'

registerRollbackGuardContract({ label: 'remote-networks', handler: rollback })

const PRIOR = {
  name: 'DMZ',
  description: 'edited in the console',
  group: 'Legacy',
  cidrs: ['10.0.0.0/8', '192.168.5.0/24'],
}

const UPDATED = { itemId: 'item-dmz', name: 'DMZ', existed: true, id: 42, prior: PRIOR }
const CREATED = { itemId: 'item-new', name: 'New Net', existed: false, id: 77 }

function deployStatusCalls<T extends { url: string }>(calls: T[]): T[] {
  return calls.filter((call) => call.url.endsWith(DEPLOY_STATUS))
}

test('remote-networks rollback: deletes a network the deploy created, then applies the undo', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), `${PATH}/77`)
    assert.equal(deployStatusCalls(calls).length, 1, 'a staged delete is not live until it is deployed')
    assert.equal(pathOf(calls[1]), DEPLOY_STATUS)
    assert.deepEqual(bodyOf(calls[1]), { type: 'INCREMENTAL' })
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 0 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('remote-networks rollback: restores exactly the prior state deploy captured', async () => {
  // Rollback writes back what was live before the deploy, not the canvas the
  // deploy wanted — this is the assertion that catches a deploy recording the
  // desired values as "prior".
  const { calls, restore } = recordFetch([ok({}), ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${PATH}/42`)
    assert.deepEqual(bodyOf(calls[0]), PRIOR)
    assert.equal(deployStatusCalls(calls).length, 1)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('remote-networks rollback: an entry with no recorded id makes no call at all', async () => {
  // Deploy could not read the id back from the create response. There is no
  // safe object to address, so rollback must not invent a write.
  for (const entry of [
    { name: 'No Id', existed: false },
    { name: 'No Id', existed: true, prior: PRIOR },
  ]) {
    const { calls, restore } = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ entries: [entry] }))

      assert.equal(calls.length, 0, `entry ${JSON.stringify(entry)} must produce no call`)
      assert.equal(result.success, true)
    } finally {
      restore()
    }
  }
})

test('remote-networks rollback: an updated entry with no recorded prior writes nothing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'DMZ', existed: true, id: 42 }] }))

    assert.equal(calls.length, 0, 'no captured prior means no value to restore')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('remote-networks rollback: a network already gone is not an error', async () => {
  const { restore } = recordFetch([notFound(), ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('remote-networks rollback: a rejected restore is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([qradarError(403, 'You do not have permission to modify the network hierarchy')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('remote-networks rollback: a deploy already in progress is success, not a failure', async () => {
  const { restore } = recordFetch([ACCEPTED, deployInProgress()])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, true, 'the in-flight deploy will apply what we staged')
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('remote-networks rollback: a rejected staged deploy fails the rollback', async () => {
  // The undo is staged but not applied — reporting success would tell the
  // operator the console was restored when it still holds the deployed state.
  const { restore } = recordFetch([ACCEPTED, serverError('Deploy could not be started')])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Deploy could not be started/)
  } finally {
    restore()
  }
})

test('remote-networks rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({}), ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`DELETE ${PATH}/77`, `POST ${PATH}/42`, `POST ${DEPLOY_STATUS}`],
      'both entries are undone and a single deploy applies them',
    )
    assert.equal(deployStatusCalls(calls).length, 1, 'one deploy for the whole rollback, not one each')
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
