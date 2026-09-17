// =============================================================================
// The `rollback` contract every Panorama configuration type must satisfy.
//
// Rollback reads the state deploy recorded — a list of `{ name, existed }` plus
// the REST resource path — and DELETEs, in reverse order, only the objects this
// deploy created. Objects that already existed were updated in place and are
// deliberately left alone.
//
// That makes the shape of the recorded state the whole contract:
//
//   * An entry marked pre-existing must produce NO call. Deleting an object a
//     customer had before Veltrix touched it is not a rollback, it is an outage.
//
//   * No recorded resource path means nothing can be addressed safely, so the
//     handler must refuse rather than guess a collection to delete from.
//
//   * A 404 is a known answer ("already gone"), not an unknown one — it must not
//     abort the rest of the rollback.
//
//   * A refused DELETE must stop the rollback and be reported, and must not
//     leave a commit queued that activates a half-undone configuration.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  CREDENTIAL_WITHOUT_KEY,
  COMPONENT_WITHOUT_HOSTNAME,
  DELETE_NOT_FOUND,
  WRITE_OK,
  assertScopedAndAuthenticated,
  commitCalls,
  commitJobFinished,
  commitQueued,
  leaksSecret,
  restCalls,
  restError,
  rollbackContext,
  withPanorama,
  withUnreachablePanorama,
  xmlCalls,
} from './fakePanorama'
import type { ConfigFixture } from './configFixture'

type RollbackHandler = (ctx: RollbackContext) => Promise<RollbackResult>

/** The rollbackData a deploy of this fixture's two objects would have recorded. */
function recordedState(fx: ConfigFixture, rollback: Array<{ name: string; existed: boolean }>): unknown {
  return { rollback, resourcePath: fx.resourcePath }
}

/** Register the rollback contract suite for one configuration type. */
export function describeRollbackContract(fx: ConfigFixture, rollback: RollbackHandler): void {
  const label = `panorama ${fx.id} rollback`
  const created = recordedState(fx, [{ name: fx.name, existed: false }])

  test(`${label} refuses before touching Panorama when no credential is configured`, async () => {
    await withPanorama([], async (calls) => {
      const result = await rollback(rollbackContext(created, { credential: null }))

      assert.equal(result.success, false)
      assert.match(result.message, /No Panorama API key/)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} refuses before touching Panorama when the credential carries no key`, async () => {
    await withPanorama([], async (calls) => {
      const result = await rollback(rollbackContext(created, { credential: CREDENTIAL_WITHOUT_KEY }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} refuses before touching Panorama when the component has no hostname`, async () => {
    await withPanorama([], async (calls) => {
      const result = await rollback(rollbackContext(created, { component: COMPONENT_WITHOUT_HOSTNAME }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} refuses when the deploy recorded no resource path`, async () => {
    await withPanorama([], async (calls) => {
      const result = await rollback(rollbackContext({ rollback: [{ name: fx.name, existed: false }] }))

      assert.equal(result.success, false)
      assert.match(result.message, /missing resource path/)
      assert.equal(calls.length, 0, 'with nothing to address, the safe move is to delete nothing')
    })
  })

  test(`${label} refuses when there is no recorded state at all`, async () => {
    await withPanorama([], async (calls) => {
      const result = await rollback(rollbackContext(null))

      assert.equal(result.success, false)
      assert.match(result.message, /nothing to undo/)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} deletes the object this deploy created`, async () => {
    await withPanorama([WRITE_OK], async (calls) => {
      const result = await rollback(rollbackContext(created))

      assertScopedAndAuthenticated(assert, calls)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].method, 'DELETE')
      assert.equal(calls[0].resourcePath, fx.resourcePath)
      assert.equal(calls[0].hasName, true, 'a DELETE with no name addresses the whole collection')
      assert.equal(calls[0].name, fx.name)
      assert.equal(calls[0].body, '', 'a DELETE carries no entry body')

      assert.equal(result.success, true)
      assert.match(result.message, /Rolled back 1 created/)
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} leaves an object that already existed untouched`, async () => {
    await withPanorama([], async (calls) => {
      const result = await rollback(rollbackContext(recordedState(fx, [{ name: fx.name, existed: true }])))

      assert.equal(
        calls.length,
        0,
        'deploy updated an object the customer already had; deleting it would destroy their configuration',
      )
      assert.equal(result.success, true)
      assert.match(result.message, /Rolled back 0 created/)
      assert.match(result.message, /Left 1 pre-existing/)
    })
  })

  test(`${label} deletes only what it created when the deploy did both`, async () => {
    await withPanorama([WRITE_OK], async (calls) => {
      const result = await rollback(
        rollbackContext(
          recordedState(fx, [
            { name: fx.name, existed: true },
            { name: fx.secondName, existed: false },
          ]),
        ),
      )

      const deletes = restCalls(calls).filter((c) => c.method === 'DELETE')
      assert.deepEqual(
        deletes.map((c) => c.name),
        [fx.secondName],
      )
      assert.equal(result.success, true)
      assert.match(result.message, /Rolled back 1 created/)
      assert.match(result.message, /Left 1 pre-existing/)
    })
  })

  test(`${label} deletes in reverse order of creation`, async () => {
    await withPanorama([WRITE_OK, WRITE_OK], async (calls) => {
      await rollback(
        rollbackContext(
          recordedState(fx, [
            { name: fx.name, existed: false },
            { name: fx.secondName, existed: false },
          ]),
        ),
      )

      assert.deepEqual(
        calls.map((c) => c.name),
        [fx.secondName, fx.name],
        'later objects may depend on earlier ones, so they go first',
      )
    })
  })

  test(`${label} makes no call when the deploy created nothing`, async () => {
    await withPanorama([], async (calls) => {
      const result = await rollback(rollbackContext(recordedState(fx, [])))

      assert.equal(calls.length, 0)
      assert.equal(result.success, true)
      assert.match(result.message, /Rolled back 0 created/)
    })
  })

  test(`${label} treats an object that is already gone as rolled back`, async () => {
    await withPanorama([DELETE_NOT_FOUND, WRITE_OK], async (calls) => {
      const result = await rollback(
        rollbackContext(
          recordedState(fx, [
            { name: fx.name, existed: false },
            { name: fx.secondName, existed: false },
          ]),
        ),
      )

      assert.equal(calls.length, 2, 'an object deleted by hand must not abort the rest of the rollback')
      assert.equal(result.success, true)
      assert.match(result.message, /Rolled back 2 created/)
    })
  })

  test(`${label} commits the deletions when auto_commit is on`, async () => {
    await withPanorama([WRITE_OK, commitQueued('31'), commitJobFinished('31', 'OK')], async (calls) => {
      const result = await rollback(rollbackContext(created, { autoCommit: true }))

      const xml = xmlCalls(calls)
      assert.equal(xml.length, 2)
      assert.equal(xml[0].xmlType, 'commit')
      assert.equal(calls.indexOf(xml[0]), 1, 'the commit comes after the delete, not before it')
      assert.equal(result.success, true)
      assert.match(result.message, /job 31/)
    })
  })

  test(`${label} reports failure rather than throwing when Panorama refuses the delete`, async () => {
    await withPanorama([restError(403, 'Object is referenced by a security rule')], async (calls) => {
      const result = await rollback(rollbackContext(created, { autoCommit: true }))

      assert.equal(result.success, false)
      assert.match(result.message, /Rollback failed after deleting 0 of 1/)
      assert.match(result.message, /referenced by a security rule/)
      assert.equal(commitCalls(calls).length, 0, 'a half-undone rollback must not be committed')
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} stops at the first refused delete rather than carrying on`, async () => {
    await withPanorama([restError(403, 'Object is in use')], async (calls) => {
      const result = await rollback(
        rollbackContext(
          recordedState(fx, [
            { name: fx.name, existed: false },
            { name: fx.secondName, existed: false },
          ]),
        ),
      )

      assert.equal(calls.length, 1)
      assert.equal(result.success, false)
      assert.match(result.message, /deleting 0 of 2/)
    })
  })

  test(`${label} reports failure rather than throwing when Panorama is unreachable`, async () => {
    await withUnreachablePanorama(async (calls) => {
      const result = await rollback(rollbackContext(created))

      assert.equal(result.success, false)
      assert.match(result.message, /ECONNREFUSED/)
      assert.equal(calls.length, 1)
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} deletes from the shared location only when the operator asked for it`, async () => {
    await withPanorama([WRITE_OK], async (calls) => {
      await rollback(rollbackContext(created, { deviceGroup: 'shared' }))

      assert.equal(calls[0].location, 'shared')
      assert.equal(calls[0].deviceGroup, '')
    })
  })
}
