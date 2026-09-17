// ============================================================================
// deploy for ISC MFA method configuration.
//
// There is no collection here, so every method is read-then-replaced on its own
// singleton endpoint. The interesting value is `priorEnabled`: it is the only
// record of whether the tenant had this method switched on BEFORE the deploy, and
// it is what stops reconcile and rollback from turning off multi-factor
// authentication that was already in use. The provider secret in
// `configProperties` is masked on read, so it can never be restored — which is
// exactly why the enabled flag has to be recorded correctly.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsWithMethod,
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
import { CONFIG_PATH, DELETE_PATH, METHOD, inSyncConfig, liveConfig, mfaItem } from './fixtures'

type Entries = Array<Record<string, unknown>>

function entriesOf(result: { rollbackData?: unknown }): Entries {
  return ((result.rollbackData as { entries?: Entries } | undefined)?.entries ?? []) as Entries
}

test('mfa-configs deploy: refuses without a credential instead of calling ISC', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([mfaItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.equal(result.message, MISSING_CREDENTIAL_MESSAGE)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('mfa-configs deploy: refuses when the tenant setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([mfaItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('mfa-configs deploy: reads the current config before replacing it', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(liveConfig()), ok({})])
  try {
    const result = await deploy(deployContext([mfaItem()]))

    assert.equal(result.success, true, result.message)
    const iscCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(iscCalls.length, 2)
    assert.equal(iscCalls[0].method, 'GET')
    assert.equal(pathOf(iscCalls[0]), CONFIG_PATH)
    assert.equal(iscCalls[1].method, 'PUT')
    assert.equal(pathOf(iscCalls[1]), CONFIG_PATH)
    assert.deepEqual(bodyOf(iscCalls[1]), {
      mfaMethod: METHOD,
      enabled: true,
      identityAttribute: 'email',
      configProperties: { clientId: 'okta-verify-client' },
    })
  } finally {
    restore()
  }
})

test('mfa-configs deploy: records that the method was OFF before this deploy', async () => {
  const { restore } = recordFetch([TOKEN, resource(liveConfig({ enabled: false })), ok({})])
  try {
    const result = await deploy(deployContext([mfaItem()]))

    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].method, METHOD)
    assert.equal(entries[0].priorEnabled, false, 'a method that was off must be recorded as off')
  } finally {
    restore()
  }
})

test('mfa-configs deploy: records that the method was already ON before this deploy', async () => {
  // This is the flag that stops rollback disabling multi-factor authentication
  // the tenant was already relying on.
  const { restore } = recordFetch([TOKEN, resource(inSyncConfig({ enabled: true })), ok({})])
  try {
    const result = await deploy(deployContext([mfaItem()]))

    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].priorEnabled, true, 'a method that was already on must be recorded as on')
  } finally {
    restore()
  }
})

test('mfa-configs deploy: reports a rejected write rather than throwing', async () => {
  const { restore } = recordFetch([TOKEN, resource(liveConfig()), iscError(400, 'the client id is not valid')])
  try {
    const result = await deploy(deployContext([mfaItem()]))

    assert.equal(result.success, false)
    assert.ok(result.message.includes('the client id is not valid'), result.message)
    assert.ok(result.rollbackData)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('mfa-configs deploy: rejects malformed configProperties before touching the vendor', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    const result = await deploy(deployContext([mfaItem({ configProperties: '{not json' })]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('mfa-configs deploy: disables a method it enabled that the canvas no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(liveConfig()), ok({}), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([mfaItem()], {
        priorRollbackData: { entries: [{ method: 'duo-web', priorEnabled: false }] },
      }),
    )

    assert.equal(result.success, true, result.message)
    const deletes = callsWithMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1)
    assert.equal(pathOf(deletes[0]), '/v3/mfa/duo-web/config/delete')
  } finally {
    restore()
  }
})

test('mfa-configs deploy: never disables a method the tenant had on before this app', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(liveConfig()), ok({})])
  try {
    await deploy(
      deployContext([mfaItem()], {
        priorRollbackData: { entries: [{ method: 'duo-web', priorEnabled: true }] },
      }),
    )

    assert.equal(
      callsWithMethod(calls, 'DELETE').length,
      0,
      'a method that was already enabled must be left alone — its secret cannot be put back',
    )
  } finally {
    restore()
  }
})
