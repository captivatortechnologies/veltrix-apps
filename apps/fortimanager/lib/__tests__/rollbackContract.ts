// =============================================================================
// The `rollback` contract every FortiManager configuration type must satisfy.
//
// Rollback can only undo what deploy wrote down, and the entry tells it which
// way to go: `existed: false` means this app created the object, so remove it;
// `existed: true` with a `prior` means it was already there, so put the prior
// body back with a `set` (which is an upsert).
//
// The case worth guarding hardest is the third one — an entry that says the
// object pre-existed but carries NO recorded prior. There is nothing to restore
// and no safe value to invent, so the handler must make no call at all. Writing
// a guessed body there would overwrite a customer's live object with fiction
// during what they asked for as an undo.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { MISSING_CREDENTIAL_MESSAGE } from '../fortimanager'
import {
  ADOM,
  CREDENTIAL_WITHOUT_PASSWORD,
  LOGIN_OK,
  LOGOUT_OK,
  assertLoggedInFirst,
  assertLoggedOut,
  leaksSecret,
  mutatingCalls,
  objectCalls,
  rollbackContext,
  rpcError,
  rpcOk,
  withFmg,
  withUnreachableFmg,
  workspaceCalls,
} from './fakeFmg'
import { leaksFixtureSecret, mkeyOf, urlFor, type ConfigFixture } from './configFixture'

type RollbackHandler = (ctx: RollbackContext) => Promise<RollbackResult>

/** Register the rollback contract suite for one configuration type. */
export function describeRollbackContract(fx: ConfigFixture, rollback: RollbackHandler): void {
  const label = `fortimanager ${fx.id} rollback`
  const url = urlFor(fx, ADOM)
  const mkey = mkeyOf(fx)

  const created = { entries: [{ name: fx.name, existed: false }] }
  const updated = { entries: [{ name: fx.name, existed: true, prior: fx.priorSnapshot }] }

  test(`${label} refuses before reaching FortiManager when no credential is configured`, async () => {
    await withFmg([], async (calls) => {
      const result = await rollback(rollbackContext(created, { credential: null }))

      assert.equal(result.success, false)
      assert.equal(result.message, MISSING_CREDENTIAL_MESSAGE)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} refuses before reaching FortiManager when the Host setting is blank`, async () => {
    await withFmg([], async (calls) => {
      const result = await rollback(rollbackContext(created, { settings: {} }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} refuses before reaching FortiManager when the credential carries no password`, async () => {
    await withFmg([], async (calls) => {
      const result = await rollback(rollbackContext(created, { credential: CREDENTIAL_WITHOUT_PASSWORD }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} deletes an object this app created`, async () => {
    await withFmg([LOGIN_OK, rpcOk(), LOGOUT_OK], async (calls) => {
      const result = await rollback(rollbackContext(created))

      assert.equal(result.success, true)
      assert.equal(result.message, `${fx.rollbackPrefix}: 1 deleted, 0 restored`)

      const work = assertLoggedInFirst(assert, calls)
      assert.equal(work.length, 1)
      assert.equal(work[0].rpcMethod, 'delete')
      assert.equal(work[0].rpcUrl, url)
      assert.deepEqual(work[0].filter, [mkey, '==', fx.name])
      assertLoggedOut(assert, calls)
    })
  })

  test(`${label} restores the prior body deploy recorded for an object that already existed`, async () => {
    await withFmg([LOGIN_OK, rpcOk(), LOGOUT_OK], async (calls) => {
      const result = await rollback(rollbackContext(updated))

      assert.equal(result.success, true)
      assert.equal(result.message, `${fx.rollbackPrefix}: 0 deleted, 1 restored`)

      const writes = mutatingCalls(calls)
      assert.equal(writes.length, 1)
      assert.equal(writes[0].rpcMethod, 'set', 'restoring a prior body is an upsert, not a delete')
      assert.equal(writes[0].rpcUrl, url)
      assert.deepEqual(writes[0].data, fx.priorSnapshot, 'rollback puts back exactly what was there')
    })
  })

  test(`${label} writes nothing for an entry that pre-existed but recorded no prior`, async () => {
    const noPrior = { entries: [{ name: fx.name, existed: true }] }
    await withFmg([LOGIN_OK, LOGOUT_OK], async (calls) => {
      const result = await rollback(rollbackContext(noPrior))

      assert.equal(
        mutatingCalls(calls).length,
        0,
        'with no recorded prior there is no safe value to write — inventing one overwrites live config',
      )
      assert.equal(result.message, `${fx.rollbackPrefix}: 0 deleted, 0 restored`)
    })
  })

  test(`${label} writes nothing when there is no rollback state at all`, async () => {
    for (const data of [undefined, {}, { entries: null }, { entries: 'corrupt' }]) {
      await withFmg([LOGIN_OK, LOGOUT_OK], async (calls) => {
        const result = await rollback(rollbackContext(data))

        assert.equal(result.success, true)
        assert.equal(mutatingCalls(calls).length, 0, `rollbackData ${JSON.stringify(data ?? null)} produced a write`)
      })
    }
  })

  test(`${label} reports a refused restore as a failure`, async () => {
    await withFmg([LOGIN_OK, rpcError('object check and operation error'), LOGOUT_OK], async () => {
      const result = await rollback(rollbackContext(updated))

      assert.equal(result.success, false, 'status.code is the outcome — HTTP 200 alone is not success')
      assert.match(result.message, /Rollback had errors/)
      assert.match(result.message, new RegExp(`restore ${fx.name}`))
    })
  })

  test(`${label} reports a refused delete as a failure`, async () => {
    await withFmg([LOGIN_OK, rpcError('no permission for the resource'), LOGOUT_OK], async () => {
      const result = await rollback(rollbackContext(created))

      assert.equal(result.success, false)
      assert.match(result.message, new RegExp(`delete ${fx.name}`))
    })
  })

  test(`${label} returns a failed result rather than throwing when FortiManager is unreachable`, async () => {
    await withUnreachableFmg(async () => {
      const result = await rollback(rollbackContext(created))

      assert.equal(result.success, false)
      assert.match(result.message, /ECONNREFUSED/)
    })
  })

  test(`${label} scopes every object call to the configured ADOM`, async () => {
    await withFmg([LOGIN_OK, rpcOk(), LOGOUT_OK], async (calls) => {
      await rollback(rollbackContext(updated, { adom: 'customer-a' }))

      const scoped = urlFor(fx, 'customer-a')
      for (const call of objectCalls(calls)) assert.equal(call.rpcUrl, scoped)
    })
  })

  test(`${label} never puts a secret in its result`, async () => {
    await withFmg([LOGIN_OK, rpcError('object check and operation error'), LOGOUT_OK], async () => {
      const result = await rollback(rollbackContext(updated))

      assert.equal(leaksSecret(result), false)
      assert.equal(leaksFixtureSecret(fx, result), false)
    })
  })

  test(`${label} releases the ADOM lock when a restore fails, and does not commit`, async () => {
    await withFmg([LOGIN_OK, rpcOk(), rpcError('object check and operation error'), rpcOk(), LOGOUT_OK], async (calls) => {
      const result = await rollback(rollbackContext(updated, { workspaceMode: true }))

      assert.equal(result.success, false)
      assert.deepEqual(
        workspaceCalls(calls).map((c) => c.rpcUrl),
        [`/dvmdb/adom/${ADOM}/workspace/lock`, `/dvmdb/adom/${ADOM}/workspace/unlock`],
        'a rollback that failed mid-way must still hand the ADOM back',
      )
    })
  })

  test(`${label} commits and unlocks the ADOM workspace after a clean rollback`, async () => {
    await withFmg([LOGIN_OK, rpcOk(), rpcOk(), rpcOk(), rpcOk(), LOGOUT_OK], async (calls) => {
      const result = await rollback(rollbackContext(updated, { workspaceMode: true }))

      assert.equal(result.success, true)
      assert.deepEqual(
        workspaceCalls(calls).map((c) => c.rpcUrl),
        [
          `/dvmdb/adom/${ADOM}/workspace/lock`,
          `/dvmdb/adom/${ADOM}/workspace/commit`,
          `/dvmdb/adom/${ADOM}/workspace/unlock`,
        ],
      )
    })
  })

  test(`${label} writes nothing when the ADOM workspace lock cannot be taken`, async () => {
    await withFmg([LOGIN_OK, rpcError('workspace is locked by another administrator', -20)], async (calls) => {
      const result = await rollback(rollbackContext(created, { workspaceMode: true }))

      assert.equal(result.success, false)
      assert.match(result.message, /Failed to lock ADOM/)
      assert.equal(mutatingCalls(calls).length, 0)
      assertLoggedOut(assert, calls)
    })
  })
}
