// rollback for ariel-copy-profiles.
//
// The shared contract covers the refusals and "nothing recorded means no call".
// What is specific here: the restore rebuilds the body from the captured state
// and re-sends `host_id`, because the host is the object's identity — and the
// excluded bucket ids go back exactly as they were read, not as the canvas
// wanted them.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  assertQRadarHeaders,
  bodyOf,
  leaksToken,
  notFound,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  rollbackContext,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/disaster_recovery/ariel_copy_profiles'

registerRollbackGuardContract({ label: 'ariel-copy-profiles', handler: rollback })

const PRIOR = {
  destinationHostIp: '10.99.0.9',
  destinationPort: 32000,
  enabled: false,
  frequency: 7200,
  bandwidthLimit: 2048,
  excludeEventRetentionBucketIds: [102],
  excludeFlowRetentionBucketIds: [],
}

const UPDATED = {
  itemId: 'item-dr',
  name: 'DR to secondary site',
  hostId: 53,
  existed: true,
  id: 900,
  prior: PRIOR,
}

const CREATED = { itemId: 'item-new', name: 'New DR', hostId: 54, existed: false, id: 77 }

test('ariel-copy-profiles rollback: restores the prior state, host id and bucket ids included', async () => {
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${PATH}/900`)
    assert.deepEqual(bodyOf(calls[0]), {
      host_id: 53,
      destination_host_ip: '10.99.0.9',
      destination_port: 32000,
      enabled: false,
      frequency: 7200,
      bandwidth_limit: 2048,
      exclude_event_retention_bucket_ids: [102],
      exclude_flow_retention_bucket_ids: [],
    })
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles rollback: a field the profile never carried is not sent back as a value', async () => {
  // The profile had no schedule window. Re-sending start_date/end_date as null
  // would be a change, not a restore.
  const { calls, restore } = recordFetch([ok({})])
  try {
    await rollback(rollbackContext({ entries: [UPDATED] }))

    const body = bodyOf(calls[0]) as Record<string, unknown>
    assert.equal('start_date' in body, false)
    assert.equal('end_date' in body, false)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles rollback: deletes a profile the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), `${PATH}/77`)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles rollback: a 202 or a 404 on the delete is not an error', async () => {
  // 202 is an accepted asynchronous delete; 404 means the profile is already
  // gone, which is the state rollback was trying to reach.
  for (const answer of [ACCEPTED, notFound()]) {
    const { restore } = recordFetch([answer])
    try {
      const result = await rollback(rollbackContext({ entries: [CREATED] }))

      assert.equal(result.success, true, `status ${answer.status} must not read as a failed delete`)
      assert.match(String(result.message), /1 deleted/)
    } finally {
      restore()
    }
  }
})

test('ariel-copy-profiles rollback: an entry with no recorded id makes no call', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Half Created', hostId: 54, existed: false }] }),
    )

    assert.equal(calls.length, 0, 'no id means nothing to address')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles rollback: an updated entry with no recorded prior state makes no call', async () => {
  // Rebuilding a body from nothing would point the DR copy at an empty
  // destination and re-include every retention bucket.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'DR to secondary site', hostId: 53, existed: true, id: 900 }] }),
    )

    assert.equal(calls.length, 0, 'no recorded prior means no restore')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles rollback: a rejected restore is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([qradarError(403, 'You do not have permission to modify disaster recovery settings')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('ariel-copy-profiles rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`DELETE ${PATH}/77`, `POST ${PATH}/900`],
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
