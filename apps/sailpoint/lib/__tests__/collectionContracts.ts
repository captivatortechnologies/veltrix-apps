// =============================================================================
// Reusable deploy / rollback / driftDetect contracts for the ISC "collection"
// configuration types.
//
// Most of this app's configuration types manage a flat, name-keyed ISC
// collection and all three vendor-writing handlers follow one shape:
//
//   deploy       list the collection → PATCH/PUT what matches by name, POST what
//                does not, record a rollback entry per item, then delete what a
//                previous deploy created and the canvas no longer declares.
//   rollback     restore the recorded prior for what deploy updated, DELETE what
//                deploy created, skip anything with nothing recorded.
//   driftDetect  list the collection and compare field by field; never write.
//
// The differences between config types are the path, the write method and the
// field names — not the behaviour worth asserting. These contracts pin the
// behaviour once; each config type's own test file supplies its fixtures and
// adds whatever is specific to itself.
//
// Deliberately NOT asserted here: what drift reports when it could not read live
// state. Every drift handler in this app answers a failed listing with a bare
// `hasDrift: false` (no `checked: false`), which the platform reads as a positive
// "checked and found nothing" and uses to clear real drift. Asserting it would
// bless that; see the notes in HANDLER-CORRECTNESS.md §3.
//
// This is NOT a test file — the runner only collects `*.test.ts`.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  CanvasItemSnapshot,
  DeployContext,
  DeployResult,
  DriftContext,
  DriftResult,
  RollbackContext,
  RollbackResult,
} from '@veltrixsecops/app-sdk'
import { MISSING_CREDENTIAL_MESSAGE } from '../isc'
import {
  BASE_URL,
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsWithMethod,
  created,
  driftContext,
  deployContext,
  iscError,
  leaksSecret,
  listPage,
  notFound,
  ok,
  pathOf,
  recordFetch,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from './fakeIsc'

type Entries = Array<Record<string, unknown>>

/** The rollback entries a deploy recorded. */
function entriesOf(result: DeployResult): Entries {
  return ((result.rollbackData as { entries?: Entries } | undefined)?.entries ?? []) as Entries
}

// --- deploy -------------------------------------------------------------------

export interface CollectionDeployContract {
  /** The configuration type's id, used only in test titles. */
  label: string
  handler: (ctx: DeployContext) => Promise<DeployResult>
  /** The collection path the handler lists through, before `?offset=…`. */
  listPath: string
  /** The path a create POSTs to. */
  createPath: string
  /** The full path an update of `live` must hit. */
  updatePath: string
  updateMethod: 'PATCH' | 'PUT'
  /** The canvas item declaring the desired object. */
  item: CanvasItemSnapshot
  /** The live object ISC returns for that item — deliberately DIFFERENT from it. */
  live: Record<string, unknown>
  /** What the create endpoint returns. Defaults to `{ id: 'created-1' }`. */
  createdBody?: Record<string, unknown>
  /** Assert the create body carries what the canvas declared. */
  assertCreateBody?: (body: unknown) => void
  /** Declared values the create body must carry on the wire. */
  createBodyIncludes?: string[]
  /** Declared values the update body must carry — the update is what overwrites. */
  updateBodyIncludes?: string[]
  /**
   * Assert the rollback entry recorded for the UPDATE path carries the values
   * `live` had, not the ones the canvas asked for. Rollback restores what was
   * there; an entry built from the desired state restores nothing.
   */
  assertPrior: (entry: Record<string, unknown>) => void
  /** Assert the rollback entry recorded for the CREATE path. */
  assertCreatedEntry?: (entry: Record<string, unknown>) => void
  /**
   * A rollback entry from a previous deploy for an object this app created and
   * the canvas no longer declares, plus the DELETE the reconcile must produce.
   */
  reconcile?: { priorEntry: Record<string, unknown>; deletePath: string }
}

export function registerCollectionDeployContract(c: CollectionDeployContract): void {
  const createdBody = c.createdBody ?? { id: 'created-1' }

  test(`${c.label} deploy: refuses without a credential instead of calling ISC`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext([c.item], { credential: null }))

      assert.equal(result.success, false)
      assert.equal(result.message, MISSING_CREDENTIAL_MESSAGE)
      assert.equal(calls.length, 0, 'must not reach ISC without a credential')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: refuses when the tenant setting is missing`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext([c.item], { settings: {} }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'without a tenant there is no API host to call')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: a failed listing stops the deploy before it writes`, async () => {
    const { calls, restore } = recordFetch([TOKEN, iscError(500, 'upstream failure')])
    try {
      const result = await c.handler(deployContext([c.item]))

      assert.equal(result.success, false)
      assert.match(result.message, /Failed to list/i)
      assert.equal(writeCalls(calls).length, 0, 'a deploy that could not read live state must not write')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: authenticates, then creates what does not exist`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([]), created(createdBody)])
    try {
      const result = await c.handler(deployContext([c.item]))

      assert.equal(result.success, true, result.message)
      const iscCalls = assertAuthenticatedFirst(assert, calls)
      assert.equal(pathOf(iscCalls[0]).startsWith(c.listPath), true, `listed ${pathOf(iscCalls[0])}`)

      const writes = writeCalls(calls)
      assert.equal(writes.length, 1, `expected one write, got ${writes.map((w) => `${w.method} ${pathOf(w)}`).join(', ')}`)
      assert.equal(writes[0].method, 'POST')
      assert.equal(pathOf(writes[0]), c.createPath)
      if (c.assertCreateBody) c.assertCreateBody(bodyOf(writes[0]))
      for (const fragment of c.createBodyIncludes ?? []) {
        assert.ok(
          writes[0].body.includes(fragment),
          `create body did not carry the declared ${fragment}: ${writes[0].body}`,
        )
      }

      const entries = entriesOf(result)
      assert.equal(entries.length, 1, 'deploy must record a rollback entry for what it created')
      assert.equal(entries[0].existed, false, 'a created object must be recorded as not pre-existing')
      if (c.assertCreatedEntry) c.assertCreatedEntry(entries[0])
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: updates what already exists instead of creating a duplicate`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([c.live]), ok({})])
    try {
      const result = await c.handler(deployContext([c.item]))

      assert.equal(result.success, true, result.message)
      const writes = writeCalls(calls)
      assert.equal(writes.length, 1, `expected one write, got ${writes.map((w) => `${w.method} ${pathOf(w)}`).join(', ')}`)
      assert.equal(writes[0].method, c.updateMethod)
      assert.equal(pathOf(writes[0]), c.updatePath)
      assert.equal(callsWithMethod(calls, 'POST').length, 0, 'must not create an object that already exists')
      for (const fragment of c.updateBodyIncludes ?? []) {
        assert.ok(
          writes[0].body.includes(fragment),
          `update body did not carry the declared ${fragment}: ${writes[0].body}`,
        )
      }
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: records the LIVE prior state, not the desired canvas values`, async () => {
    const { restore } = recordFetch([TOKEN, listPage([c.live]), ok({})])
    try {
      const result = await c.handler(deployContext([c.item]))

      const entries = entriesOf(result)
      assert.equal(entries.length, 1, 'deploy must record a rollback entry for what it updated')
      assert.equal(entries[0].existed, true, 'an updated object must be recorded as pre-existing')
      c.assertPrior(entries[0])
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: reports a rejected write as a failed result rather than throwing`, async () => {
    const { restore } = recordFetch([TOKEN, listPage([]), iscError(400, 'name is already in use')])
    try {
      const result = await c.handler(deployContext([c.item]))

      assert.equal(result.success, false)
      assert.ok(
        result.message.includes('name is already in use'),
        `expected the ISC message to be surfaced, got: ${result.message}`,
      )
      assert.ok(result.rollbackData, 'a failed deploy must still hand back whatever it captured')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: never puts the token or the client secret in its result`, async () => {
    const { restore } = recordFetch([TOKEN, listPage([c.live]), ok({})])
    try {
      const result = await c.handler(deployContext([c.item]))
      assert.equal(leaksSecret(result), false, 'deploy result or rollbackData leaked a secret')
    } finally {
      restore()
    }
  })

  if (c.reconcile) {
    const reconcile = c.reconcile
    test(`${c.label} deploy: deletes what it created previously and no longer declares`, async () => {
      const { calls, restore } = recordFetch([TOKEN, listPage([]), created(createdBody), NO_CONTENT])
      try {
        const result = await c.handler(
          deployContext([c.item], { priorRollbackData: { entries: [reconcile.priorEntry] } }),
        )

        assert.equal(result.success, true, result.message)
        const deletes = callsWithMethod(calls, 'DELETE')
        assert.equal(deletes.length, 1, 'expected exactly one reconcile delete')
        assert.equal(pathOf(deletes[0]), reconcile.deletePath)
      } finally {
        restore()
      }
    })
  }
}

// --- rollback -----------------------------------------------------------------

export interface RollbackContract {
  label: string
  handler: (ctx: RollbackContext) => Promise<RollbackResult>
  /** An entry deploy recorded for an object it UPDATED, and the restore it must produce. */
  restore?: {
    entry: Record<string, unknown>
    method: 'PATCH' | 'PUT' | 'POST'
    path: string
    /** Substrings the restore body must contain — the prior values, not the desired ones. */
    bodyIncludes?: string[]
  }
  /** An entry deploy recorded for an object it CREATED, and the removal it must produce. */
  remove?: {
    entry: Record<string, unknown>
    method: 'DELETE' | 'POST'
    path: string
  }
  /**
   * Entries that record nothing recoverable — no id, no prior, or explicitly
   * pre-existing with nothing captured. Each must make NO vendor call: writing an
   * invented value is worse than leaving the object alone.
   */
  unrecoverable?: Array<Record<string, unknown>>
}

export function registerRollbackContract(c: RollbackContract): void {
  test(`${c.label} rollback: refuses without a credential instead of calling ISC`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const entry = c.restore?.entry ?? c.remove?.entry ?? {}
      const result = await c.handler(rollbackContext({ entries: [entry] }, { credential: null }))

      assert.equal(result.success, false)
      assert.equal(result.message, MISSING_CREDENTIAL_MESSAGE)
      assert.equal(calls.length, 0, 'must not reach ISC without a credential')
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: does nothing when the deployment recorded no entries`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(rollbackContext({ entries: [] }))

      assert.equal(result.success, true)
      assert.equal(calls.length, 0, 'nothing to undo must mean no vendor call at all')
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: does nothing when the rollback data is absent or malformed`, async () => {
    for (const data of [undefined, null, {}, { entries: 'not-an-array' }]) {
      const { calls, restore } = recordFetch([])
      try {
        const result = await c.handler(rollbackContext(data))

        assert.equal(result.success, true, `rollbackData ${JSON.stringify(data)} should be a no-op`)
        assert.equal(calls.length, 0, `rollbackData ${JSON.stringify(data)} must not reach ISC`)
      } finally {
        restore()
      }
    }
  })

  if (c.restore) {
    const spec = c.restore
    test(`${c.label} rollback: restores the prior state deploy recorded`, async () => {
      const { calls, restore } = recordFetch([TOKEN, ok({})])
      try {
        const result = await c.handler(rollbackContext({ entries: [spec.entry] }))

        assert.equal(result.success, true, result.message)
        const iscCalls = assertAuthenticatedFirst(assert, calls)
        assert.equal(iscCalls.length, 1, 'expected exactly one restore call')
        assert.equal(iscCalls[0].method, spec.method)
        assert.equal(pathOf(iscCalls[0]), spec.path)
        for (const fragment of spec.bodyIncludes ?? []) {
          assert.ok(
            iscCalls[0].body.includes(fragment),
            `restore body did not carry ${fragment}: ${iscCalls[0].body}`,
          )
        }
      } finally {
        restore()
      }
    })

    test(`${c.label} rollback: reports a rejected restore rather than throwing`, async () => {
      const { restore } = recordFetch([TOKEN, iscError(403, 'not authorized to modify this object')])
      try {
        const result = await c.handler(rollbackContext({ entries: [spec.entry] }))

        assert.equal(result.success, false)
        assert.ok(
          result.message.includes('not authorized to modify this object'),
          `expected the ISC message to be surfaced, got: ${result.message}`,
        )
        assert.equal(leaksSecret(result), false)
      } finally {
        restore()
      }
    })
  }

  if (c.remove) {
    const spec = c.remove
    test(`${c.label} rollback: removes what the deploy created`, async () => {
      const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
      try {
        const result = await c.handler(rollbackContext({ entries: [spec.entry] }))

        assert.equal(result.success, true, result.message)
        const iscCalls = assertAuthenticatedFirst(assert, calls)
        assert.equal(iscCalls.length, 1, 'expected exactly one removal call')
        assert.equal(iscCalls[0].method, spec.method)
        assert.equal(pathOf(iscCalls[0]), spec.path)
      } finally {
        restore()
      }
    })

    test(`${c.label} rollback: treats an already-gone object as nothing left to undo`, async () => {
      const { restore } = recordFetch([TOKEN, notFound()])
      try {
        const result = await c.handler(rollbackContext({ entries: [spec.entry] }))
        assert.equal(result.success, true, result.message)
      } finally {
        restore()
      }
    })
  }

  if (c.unrecoverable?.length) {
    const entries = c.unrecoverable
    test(`${c.label} rollback: makes no call for an entry with nothing recorded to restore`, async () => {
      for (const entry of entries) {
        const { calls, restore } = recordFetch([TOKEN, ok({})])
        try {
          const result = await c.handler(rollbackContext({ entries: [entry] }))

          assert.equal(result.success, true, result.message)
          assert.equal(
            vendorCalls(calls).length,
            0,
            `entry ${JSON.stringify(entry)} has no recorded prior — rollback must not invent one`,
          )
        } finally {
          restore()
        }
      }
    })
  }
}

// --- driftDetect --------------------------------------------------------------

export interface CollectionDriftContract {
  label: string
  handler: (ctx: DriftContext) => Promise<DriftResult>
  /** The collection path the handler lists through, before `?offset=…`. */
  listPath: string
  /** The canvas item describing what was deployed. */
  item: CanvasItemSnapshot
  /** A live object that matches `item` in every tracked field. */
  matchingLive: Record<string, unknown>
  /** A live object that differs from `item` in exactly one tracked field. */
  driftedLive: Record<string, unknown>
  /** The `field` the diff for `driftedLive` must carry. */
  driftedField: string
  /** The `field` the diff must carry when the object is missing from the tenant. */
  absentField: string
  /**
   * Set false for the nested configuration types, whose CHILD listing ignores its
   * own failure and turns an unreadable parent into "every declared object was
   * deleted". That is a real defect, not a contract — it is reported, not
   * asserted. See HANDLER-CORRECTNESS.md §3.
   */
  assertsFailedListing?: boolean
}

export function registerCollectionDriftContract(c: CollectionDriftContract): void {
  test(`${c.label} driftDetect: makes no ISC call at all without a credential`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(driftContext([c.item], { credential: null }))

      // The emptiness of `diffs` is the assertable part: with no credential the
      // handler has established nothing, so it must not manufacture a diff. What
      // it reports in `hasDrift` for that case is the open defect above.
      assert.deepEqual(result.diffs, [])
      assert.equal(calls.length, 0, 'must not reach ISC without a credential')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports no drift when the live object matches`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([c.matchingLive])])
    try {
      const result = await c.handler(driftContext([c.item]))

      assert.deepEqual(result.diffs, [], 'a matching live object must produce no diff')
      assert.equal(result.hasDrift, false)
      const iscCalls = assertAuthenticatedFirst(assert, calls)
      assert.equal(pathOf(iscCalls[0]).startsWith(c.listPath), true, `listed ${pathOf(iscCalls[0])}`)
      assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports the field someone changed in the tenant`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([c.driftedLive])])
    try {
      const result = await c.handler(driftContext([c.item]))

      assert.equal(result.hasDrift, true, 'a changed live object must be reported as drift')
      assert.ok(
        result.diffs.some((d) => d.field === c.driftedField),
        `expected a diff for ${c.driftedField}, got ${result.diffs.map((d) => d.field).join(', ') || '(none)'}`,
      )
      assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
      assert.equal(leaksSecret(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports a declared object the tenant no longer has`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([])])
    try {
      const result = await c.handler(driftContext([c.item]))

      assert.equal(result.hasDrift, true)
      const absent = result.diffs.find((d) => d.field === c.absentField)
      assert.ok(absent, `expected a diff for ${c.absentField}, got ${result.diffs.map((d) => d.field).join(', ') || '(none)'}`)
      assert.equal(absent.actual, 'absent')
      assert.equal(absent.severity, 'critical')
      assert.equal(writeCalls(calls).length, 0)
    } finally {
      restore()
    }
  })

  if (c.assertsFailedListing !== false) {
    test(`${c.label} driftDetect: a failed listing is not reported as the objects being deleted`, async () => {
      const { calls, restore } = recordFetch([TOKEN, iscError(500, 'upstream failure')])
      try {
        const result = await c.handler(driftContext([c.item]))

        // What the handler concludes about drift when it could not look is the
        // open defect; that it must not claim the objects were DELETED is not.
        assert.equal(
          result.diffs.filter((d) => d.actual === 'absent').length,
          0,
          'an unreadable tenant is not the same as a deleted object',
        )
        assert.equal(writeCalls(calls).length, 0)
      } finally {
        restore()
      }
    })
  }
}

/** Re-exported so a config type's own extra tests need only one import. */
export { BASE_URL }
