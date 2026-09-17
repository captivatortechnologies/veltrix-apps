// rollback for remote-services.
//
// The shared contract covers the refusals (no credential, no console host,
// nothing recorded). What is specific here: a service this deploy created is
// deleted, a service it only updated is POSTed back to the state deploy
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

const PATH = '/staged_config/remote_services'
const DEPLOY_STATUS = '/staged_config/deploy_status'

registerRollbackGuardContract({ label: 'remote-services', handler: rollback })

const PRIOR = {
  name: 'Cloud Backup',
  description: 'edited in the console',
  group: 'Unclassified',
  cidrs: ['198.51.100.0/24', '192.0.2.0/24'],
}

const UPDATED = { itemId: 'item-backup', name: 'Cloud Backup', existed: true, id: 31, prior: PRIOR }
const CREATED = { itemId: 'item-new', name: 'Partner VPN', existed: false, id: 55 }

function deployStatusCalls<T extends { url: string }>(calls: T[]): T[] {
  return calls.filter((call) => call.url.endsWith(DEPLOY_STATUS))
}

test('remote-services rollback: deletes a service the deploy created, then applies the undo', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), `${PATH}/55`)
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

test('remote-services rollback: restores exactly the prior state deploy captured', async () => {
  // Rollback writes back what was live before the deploy, not the canvas the
  // deploy wanted — this is the assertion that catches a deploy recording the
  // desired values as "prior".
  const { calls, restore } = recordFetch([ok({}), ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${PATH}/31`)
    assert.deepEqual(bodyOf(calls[0]), PRIOR)
    assert.equal(deployStatusCalls(calls).length, 1)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('remote-services rollback: an entry with no recorded id makes no call at all', async () => {
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

test('remote-services rollback: an updated entry with no recorded prior writes nothing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Cloud Backup', existed: true, id: 31 }] }))

    assert.equal(calls.length, 0, 'no captured prior means no value to restore')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('remote-services rollback: a service already gone is not an error', async () => {
  const { restore } = recordFetch([notFound(), ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('remote-services rollback: a rejected restore is a failed result, not a thrown error', async () => {
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

test('remote-services rollback: a deploy already in progress is success, not a failure', async () => {
  const { restore } = recordFetch([ACCEPTED, deployInProgress()])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, true, 'the in-flight deploy will apply what we staged')
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('remote-services rollback: a rejected staged deploy fails the rollback', async () => {
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

test('remote-services rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({}), ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`DELETE ${PATH}/55`, `POST ${PATH}/31`, `POST ${DEPLOY_STATUS}`],
      'both entries are undone and a single deploy applies them',
    )
    assert.equal(deployStatusCalls(calls).length, 1, 'one deploy for the whole rollback, not one each')
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
