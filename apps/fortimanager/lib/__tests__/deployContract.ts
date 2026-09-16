// =============================================================================
// The `deploy` contract every FortiManager configuration type must satisfy.
//
// Shape of the handler under test, identical across all 32 types:
//
//   resolve credential -> (lock ADOM) -> get the object table -> upsert each
//   declared object -> delete the objects THIS app created and no longer
//   declares -> (commit + unlock) -> logout
//
// What the assertions below are actually protecting, in the order the
// correctness notes rank them:
//
//   * it must refuse BEFORE reaching the customer's FortiManager when the
//     connection is unusable — zero calls, not merely a failed result;
//   * a listing that FAILED must not become an empty ADOM, because an empty
//     ADOM means "create everything" and, worse, "delete the reconcile set";
//   * a rejected write arrives as HTTP 200 with a non-zero `status.code`, and
//     must be reported as a failure;
//   * the rollback entry must carry the LIVE prior body, not the desired canvas
//     values — every fixture's `livePrior` differs from its `item` so a handler
//     that recorded the wrong side fails here;
//   * a workspace-mode deploy that takes the ADOM lock must release it on the
//     failure path too, or the ADOM stays locked against every administrator.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { MISSING_CREDENTIAL_MESSAGE } from '../fortimanager'
import {
  ADOM,
  CREDENTIAL_WITHOUT_PASSWORD,
  LOGIN_OK,
  LOGOUT_OK,
  assertLoggedInFirst,
  assertLoggedOut,
  deployContext,
  leaksSecret,
  loginFailure,
  mutatingCalls,
  objectCalls,
  rpcError,
  rpcOk,
  withFmg,
  withUnreachableFmg,
  workspaceCalls,
} from './fakeFmg'
import { leaksFixtureSecret, mkeyOf, renamed, urlFor, type ConfigFixture } from './configFixture'

type DeployHandler = (ctx: DeployContext) => Promise<DeployResult>

interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

function entriesOf(result: DeployResult): RollbackEntry[] {
  const data = result.rollbackData as { entries?: RollbackEntry[] } | undefined
  assert.ok(Array.isArray(data?.entries), 'deploy must return rollbackData.entries — rollback cannot work without it')
  return data!.entries as RollbackEntry[]
}

/** Register the deploy contract suite for one configuration type. */
export function describeDeployContract(fx: ConfigFixture, deploy: DeployHandler): void {
  const label = `fortimanager ${fx.id} deploy`
  const url = urlFor(fx, ADOM)
  const mkey = mkeyOf(fx)

  test(`${label} refuses before reaching FortiManager when no credential is configured`, async () => {
    await withFmg([], async (calls) => {
      const result = await deploy(deployContext([fx.item], { credential: null }))

      assert.equal(result.success, false)
      assert.equal(result.message, MISSING_CREDENTIAL_MESSAGE)
      assert.equal(calls.length, 0, 'a handler with no credential must not reach the customer at all')
    })
  })

  test(`${label} refuses before reaching FortiManager when the credential carries no password`, async () => {
    await withFmg([], async (calls) => {
      const result = await deploy(deployContext([fx.item], { credential: CREDENTIAL_WITHOUT_PASSWORD }))

      assert.equal(result.success, false)
      assert.equal(result.message, MISSING_CREDENTIAL_MESSAGE)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} refuses before reaching FortiManager when the Host setting is blank`, async () => {
    await withFmg([], async (calls) => {
      const result = await deploy(deployContext([fx.item], { settings: {} }))

      assert.equal(result.success, false)
      assert.equal(result.message, MISSING_CREDENTIAL_MESSAGE)
      assert.equal(calls.length, 0, 'with no host there is nowhere to send a request — it must not guess one')
    })
  })

  test(`${label} logs in before its first object call and ends the session`, async () => {
    await withFmg([LOGIN_OK, rpcOk([]), rpcOk(), LOGOUT_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(result.success, true)
      const work = assertLoggedInFirst(assert, calls)
      assert.equal(work[0].rpcMethod, 'get', 'the first object call reads the table it is about to write')
      assert.equal(work[0].rpcUrl, url)
      assertLoggedOut(assert, calls)
    })
  })

  test(`${label} creates an object the ADOM does not have`, async () => {
    await withFmg([LOGIN_OK, rpcOk([]), rpcOk(), LOGOUT_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(result.success, true)
      assert.equal(result.message, fx.deploySuccess)

      const writes = mutatingCalls(calls)
      assert.equal(writes.length, 1, 'one declared object is one write')
      assert.equal(writes[0].rpcMethod, 'set', 'FortiManager upserts with `set`')
      assert.equal(writes[0].rpcUrl, url)
      assert.deepEqual(writes[0].data, fx.body)

      const entries = entriesOf(result)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].name, fx.name)
      assert.equal(entries[0].existed, false, 'nothing was there, so rollback must DELETE this object')
      assert.equal(entries[0].prior, undefined, 'there is no prior state to record for a create')
    })
  })

  test(`${label} updates an object that already exists and records the LIVE prior, not the desired body`, async () => {
    await withFmg([LOGIN_OK, rpcOk([fx.livePrior]), rpcOk(), LOGOUT_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(result.success, true)

      const writes = mutatingCalls(calls)
      assert.equal(writes.length, 1)
      assert.equal(writes[0].rpcMethod, 'set')
      assert.deepEqual(writes[0].data, fx.body, 'the update sends the desired body')

      const entries = entriesOf(result)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].existed, true, 'this object was already there — rollback must RESTORE, not delete')
      assert.deepEqual(entries[0].prior, fx.priorSnapshot, 'the recorded prior is what the ADOM actually held')
      assert.notDeepEqual(
        entries[0].prior,
        fx.body,
        'recording the desired body as the prior makes rollback a no-op that looks like a restore',
      )
    })
  })

  test(`${label} matches an existing object case-insensitively rather than creating a duplicate`, async () => {
    const shouted = { ...fx.livePrior, [mkey]: fx.name.toUpperCase() }
    await withFmg([LOGIN_OK, rpcOk([shouted]), rpcOk(), LOGOUT_OK], async () => {
      const result = await deploy(deployContext([fx.item]))

      const entries = entriesOf(result)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].existed, true, 'FortiManager mkeys are case-insensitive — this is the same object')
    })
  })

  test(`${label} reports a rejection that arrived inside a 200 as a failure`, async () => {
    await withFmg([LOGIN_OK, rpcOk([]), rpcError('object check and operation error'), LOGOUT_OK], async () => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(result.success, false, 'status.code is the outcome — HTTP 200 alone is not success')
      assert.ok(result.message.startsWith(fx.deployFailurePrefix), `unexpected message: ${result.message}`)
      assert.match(result.message, /object check and operation error/)
      assert.deepEqual(entriesOf(result), [], 'a write that failed left nothing to roll back')
    })
  })

  test(`${label} still reports the objects it DID write when a later one fails`, async () => {
    const second = renamed(fx, 'veltrix-second-object')
    await withFmg([LOGIN_OK, rpcOk([]), rpcOk(), rpcError('no permission for the resource'), LOGOUT_OK], async () => {
      const result = await deploy(deployContext([fx.item, second]))

      assert.equal(result.success, false)
      const entries = entriesOf(result)
      assert.equal(entries.length, 1, 'the first object exists in the ADOM and must be recoverable')
      assert.equal(entries[0].name, fx.name)
    })
  })

  test(`${label} stops instead of treating an unreadable listing as an empty ADOM`, async () => {
    await withFmg([LOGIN_OK, rpcError('permission denied', -6), LOGOUT_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(result.success, false)
      assert.match(result.message, /list:/)
      assert.equal(
        mutatingCalls(calls).length,
        0,
        'a failed read that becomes an empty list makes every object look absent, and the reconcile pass deletes',
      )
    })
  })

  test(`${label} reports a rejected login as a failure without echoing the password`, async () => {
    await withFmg([loginFailure('Login fail: user is locked out')], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(result.success, false)
      assert.match(result.message, /Login fail/)
      assert.equal(mutatingCalls(calls).length, 0, 'an unauthenticated handler must not attempt a write')
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} returns a failed result rather than throwing when FortiManager is unreachable`, async () => {
    await withUnreachableFmg(async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(result.success, false, 'a throw surfaces as an opaque pipeline crash, not an actionable message')
      assert.match(result.message, /ECONNREFUSED/)
      assert.equal(mutatingCalls(calls).length, 0)
    })
  })

  test(`${label} deletes an object it created earlier and no longer declares`, async () => {
    const prior = { entries: [{ name: 'veltrix-retired-object', existed: false }] }
    await withFmg([LOGIN_OK, rpcOk([]), rpcOk(), rpcOk(), LOGOUT_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item], { priorRollbackData: prior }))

      assert.equal(result.success, true)
      const writes = mutatingCalls(calls)
      assert.equal(writes.length, 2)
      assert.equal(writes[1].rpcMethod, 'delete')
      assert.equal(writes[1].rpcUrl, url)
      assert.deepEqual(writes[1].filter, [mkey, '==', 'veltrix-retired-object'])
    })
  })

  test(`${label} leaves an object it did not create alone when the canvas stops declaring it`, async () => {
    const prior = { entries: [{ name: 'pre-existing-object', existed: true, prior: { [mkey]: 'pre-existing-object' } }] }
    await withFmg([LOGIN_OK, rpcOk([]), rpcOk(), LOGOUT_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item], { priorRollbackData: prior }))

      assert.equal(result.success, true)
      const writes = mutatingCalls(calls)
      assert.equal(writes.length, 1, 'an object this app never created is the customer’s, not ours to delete')
      assert.equal(writes[0].rpcMethod, 'set')
    })
  })

  test(`${label} scopes every object call to the configured ADOM`, async () => {
    await withFmg([LOGIN_OK, rpcOk([]), rpcOk(), LOGOUT_OK], async (calls) => {
      await deploy(deployContext([fx.item], { adom: 'customer-a' }))

      const scoped = urlFor(fx, 'customer-a')
      for (const call of objectCalls(calls)) {
        assert.equal(call.rpcUrl, scoped, 'a call against the wrong ADOM edits another customer’s objects')
      }
    })
  })

  test(`${label} never puts a secret in its result`, async () => {
    await withFmg([LOGIN_OK, rpcOk([fx.livePrior]), rpcOk(), LOGOUT_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(leaksSecret(result), false, 'the message and rollbackData are stored and shown to operators')
      assert.equal(
        leaksFixtureSecret(fx, result),
        false,
        'a write-only canvas secret goes to FortiManager, never into rollbackData or a message',
      )
      assert.equal(
        leaksFixtureSecret(fx, mutatingCalls(calls)[0]?.data),
        !!fx.writeOnlySecret,
        'the write-only secret must still be SENT — it is the only way FortiManager learns it',
      )
    })
  })

  // --- workspace mode --------------------------------------------------------

  test(`${label} commits and unlocks the ADOM workspace after a clean deploy`, async () => {
    const responses = [LOGIN_OK, rpcOk(), rpcOk([]), rpcOk(), rpcOk(), rpcOk(), LOGOUT_OK]
    await withFmg(responses, async (calls) => {
      const result = await deploy(deployContext([fx.item], { workspaceMode: true }))

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

  test(`${label} releases the ADOM lock when a write fails, and does not commit`, async () => {
    const responses = [LOGIN_OK, rpcOk(), rpcOk([]), rpcError('object check and operation error'), rpcOk(), LOGOUT_OK]
    await withFmg(responses, async (calls) => {
      const result = await deploy(deployContext([fx.item], { workspaceMode: true }))

      assert.equal(result.success, false)
      assert.deepEqual(
        workspaceCalls(calls).map((c) => c.rpcUrl),
        [`/dvmdb/adom/${ADOM}/workspace/lock`, `/dvmdb/adom/${ADOM}/workspace/unlock`],
        'a failed deploy must discard its staged changes AND hand the ADOM back',
      )
    })
  })

  test(`${label} reports an uncommitted workspace as a failure rather than a deployment`, async () => {
    const responses = [LOGIN_OK, rpcOk(), rpcOk([]), rpcOk(), rpcError('commit failed'), rpcOk(), LOGOUT_OK]
    await withFmg(responses, async (calls) => {
      const result = await deploy(deployContext([fx.item], { workspaceMode: true }))

      assert.equal(result.success, false, 'staged-but-uncommitted is not deployed')
      assert.match(result.message, /commit:/)
      assert.ok(
        workspaceCalls(calls).some((c) => c.rpcUrl.endsWith('/workspace/unlock')),
        'the lock is released even when the commit failed',
      )
    })
  })

  test(`${label} writes nothing when the ADOM workspace lock cannot be taken`, async () => {
    await withFmg([LOGIN_OK, rpcError('workspace is locked by another administrator', -20)], async (calls) => {
      const result = await deploy(deployContext([fx.item], { workspaceMode: true }))

      assert.equal(result.success, false)
      assert.match(result.message, /Failed to lock ADOM/)
      assert.equal(mutatingCalls(calls).length, 0, 'without the lock a write would be refused or silently staged')
      assertLoggedOut(assert, calls)
    })
  })
}
