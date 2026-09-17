// ============================================================================
// deploy for the ISC tenant configuration singletons.
//
// These are the tenant-wide settings — password org config, lockout, session and
// network policy. There is nothing to create and nothing to delete, only read and
// replace, so the read is the safety step: a PUT singleton is merged over what
// the tenant had (anything dropped from the body is lost), and the prior snapshot
// taken before the write is the only route back.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  deployContext,
  iscError,
  leaksSecret,
  ok,
  pathOf,
  recordFetch,
  resource,
  writeCalls,
} from '../../../lib/__tests__/fakeIsc'
import { MISSING_CREDENTIAL_MESSAGE } from '../../../lib/isc'
import deploy from '../deploy'
import {
  PATCH_PATH,
  PATCH_SETTING,
  PUT_PATH,
  PUT_SETTING,
  livePatchConfig,
  livePutConfig,
  patchItem,
  putItem,
} from './fixtures'

type Entries = Array<Record<string, unknown>>

function entriesOf(result: { rollbackData?: unknown }): Entries {
  return ((result.rollbackData as { entries?: Entries } | undefined)?.entries ?? []) as Entries
}

test('tenant-config-singletons deploy: refuses without a credential instead of calling ISC', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([putItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.equal(result.message, MISSING_CREDENTIAL_MESSAGE)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('tenant-config-singletons deploy: refuses when the tenant setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([putItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('tenant-config-singletons deploy: ignores a setting that is not in the registry', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await deploy(deployContext([putItem({ setting: 'not-a-real-singleton' })]))

    assert.equal(result.success, true, result.message)
    assert.equal(calls.length, 0, 'an unknown singleton has no endpoint to call')
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

test('tenant-config-singletons deploy: a PUT singleton merges over the live object and snapshots all of it', async () => {
  // A whole-object PUT drops whatever the body omits. digitTokenEnabled and
  // digitTokenLength are not declared anywhere in the canvas.
  const { calls, restore } = recordFetch([TOKEN, resource(livePutConfig()), ok({})])
  try {
    const result = await deploy(deployContext([putItem()]))

    assert.equal(result.success, true, result.message)
    const iscCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(iscCalls[0].method, 'GET')
    assert.equal(pathOf(iscCalls[0]), PUT_PATH)
    assert.equal(iscCalls[1].method, 'PUT')
    assert.deepEqual(bodyOf(iscCalls[1]), {
      customInstructionsEnabled: true,
      digitTokenEnabled: true,
      digitTokenLength: 6,
    })

    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].setting, PUT_SETTING)
    assert.equal(entries[0].method, 'PUT')
    assert.deepEqual(entries[0].prior, livePutConfig(), 'a PUT singleton must snapshot the whole prior object')
  } finally {
    restore()
  }
})

test('tenant-config-singletons deploy: a PATCH singleton only touches the declared keys', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(livePatchConfig()), ok({})])
  try {
    const result = await deploy(deployContext([patchItem()]))

    assert.equal(result.success, true, result.message)
    const write = writeCalls(calls)[0]
    assert.equal(write.method, 'PATCH')
    assert.equal(pathOf(write), PATCH_PATH)
    assert.deepEqual(bodyOf(write), [
      { op: 'replace', path: '/maximumAttempts', value: 5 },
      { op: 'replace', path: '/lockoutDuration', value: 15 },
    ])

    const entries = entriesOf(result)
    assert.equal(entries[0].method, 'PATCH')
    assert.deepEqual(
      entries[0].prior,
      { maximumAttempts: 10, lockoutDuration: 30 },
      'a PATCH singleton must snapshot only the keys it is about to change',
    )
  } finally {
    restore()
  }
})

test('tenant-config-singletons deploy: a failed read stops that setting before it writes', async () => {
  const { calls, restore } = recordFetch([TOKEN, iscError(403, 'not authorized to read this configuration')])
  try {
    const result = await deploy(deployContext([putItem()]))

    assert.equal(result.success, false)
    assert.ok(result.message.includes('not authorized to read this configuration'), result.message)
    assert.equal(writeCalls(calls).length, 0, 'a singleton that could not be read must not be written')
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

test('tenant-config-singletons deploy: reports a rejected write rather than throwing', async () => {
  const { restore } = recordFetch([TOKEN, resource(livePutConfig()), iscError(400, 'the value is out of range')])
  try {
    const result = await deploy(deployContext([putItem()]))

    assert.equal(result.success, false)
    assert.ok(result.message.includes('the value is out of range'), result.message)
    assert.ok(result.rollbackData)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('tenant-config-singletons deploy: reverts a singleton it configured and no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(livePutConfig()), ok({}), ok({})])
  try {
    const result = await deploy(
      deployContext([putItem()], {
        priorRollbackData: {
          entries: [{ setting: PATCH_SETTING, method: 'PATCH', prior: { maximumAttempts: 3 } }],
        },
      }),
    )

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)
    assert.equal(pathOf(writes[1]), PATCH_PATH)
    assert.deepEqual(bodyOf(writes[1]), [{ op: 'replace', path: '/maximumAttempts', value: 3 }])
  } finally {
    restore()
  }
})
