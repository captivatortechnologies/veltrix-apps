// =============================================================================
// Reusable deploy / driftDetect contracts for the NESTED ISC configuration types.
//
// Four configuration types manage a child collection that hangs off a parent
// resolved by name — dimensions under a role, lifecycle states under an identity
// profile, provisioning policies and schemas under a source. They all walk the
// same path:
//
//   list the parents  →  resolve the parent by name  →  list that parent's
//   children  →  update the child that matches, create the one that does not.
//
// Two things separate them from the flat collections and are worth pinning once:
// a parent that cannot be found must be reported without writing anything, and a
// CHILD listing that fails must not be treated as "this parent has no children"
// — that difference is the whole of deploy's safety here.
//
// Deliberately NOT asserted: what driftDetect concludes when the CHILD listing
// fails. All four drift handlers ignore `listed.ok` on that call and build the
// child map from `listed.items` regardless, so an unreadable parent turns every
// declared child into `actual: 'absent', severity: 'critical'`. That is the
// failure HANDLER-CORRECTNESS.md §3 describes; it is reported, not blessed.
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
} from '@veltrixsecops/app-sdk'
import { MISSING_CREDENTIAL_MESSAGE } from '../isc'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  callsWithMethod,
  created,
  deployContext,
  driftContext,
  iscError,
  leaksSecret,
  listPage,
  ok,
  pathOf,
  recordFetch,
  writeCalls,
} from './fakeIsc'

type Entries = Array<Record<string, unknown>>

function entriesOf(result: DeployResult): Entries {
  return ((result.rollbackData as { entries?: Entries } | undefined)?.entries ?? []) as Entries
}

// --- deploy -------------------------------------------------------------------

export interface NestedDeployContract {
  label: string
  handler: (ctx: DeployContext) => Promise<DeployResult>
  /** The parent collection the handler resolves names through. */
  parentListPath: string
  /** The parent object as ISC returns it, carrying the id the child path uses. */
  parent: Record<string, unknown>
  /** The child collection path under that parent. */
  childPath: string
  /** The canvas item declaring the desired child. */
  item: CanvasItemSnapshot
  /** The live child ISC returns — deliberately DIFFERENT from `item`. */
  live: Record<string, unknown>
  /** What the create endpoint returns. Defaults to `{ id: 'created-1' }`. */
  createdBody?: Record<string, unknown>
  updateMethod: 'PATCH' | 'PUT'
  /** The full path an update of `live` must hit. */
  updatePath: string
  /** Declared values the create body must carry on the wire. */
  createBodyIncludes?: string[]
  /** Declared values the update body must carry. */
  updateBodyIncludes?: string[]
  /** Assert the rollback entry recorded for a create. */
  assertCreatedEntry: (entry: Record<string, unknown>) => void
  /** Assert the entry recorded for an update carries the LIVE prior, not the canvas values. */
  assertPrior: (entry: Record<string, unknown>) => void
  /** Matches the message when the named parent is not in the parent listing. */
  parentMissingMatch: RegExp
  /** Matches the message when the child listing fails. */
  childListFailureMatch: RegExp
  /** A prior entry for a child this app created and no longer declares, and the DELETE it implies. */
  reconcile: { priorEntry: Record<string, unknown>; deletePath: string }
}

export function registerNestedDeployContract(c: NestedDeployContract): void {
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
      assert.equal(calls.length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: a failed parent listing stops the deploy before it writes`, async () => {
    const { calls, restore } = recordFetch([TOKEN, iscError(500, 'upstream failure')])
    try {
      const result = await c.handler(deployContext([c.item]))

      assert.equal(result.success, false)
      assert.match(result.message, /Failed to list/i)
      assert.equal(writeCalls(calls).length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: reports a parent it cannot find, without writing`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([])])
    try {
      const result = await c.handler(deployContext([c.item]))

      assert.equal(result.success, false)
      assert.match(result.message, c.parentMissingMatch)
      assert.equal(writeCalls(calls).length, 0, 'an unresolved parent must not be written into')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: a failed child listing is reported, not read as "no children"`, async () => {
    // Treating an unreadable child collection as empty would make the next step
    // create a duplicate of something that is already there.
    const { calls, restore } = recordFetch([TOKEN, listPage([c.parent]), iscError(500, 'upstream failure')])
    try {
      const result = await c.handler(deployContext([c.item]))

      assert.equal(result.success, false)
      assert.match(result.message, c.childListFailureMatch)
      assert.equal(writeCalls(calls).length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: authenticates, then creates the child that does not exist`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([c.parent]), listPage([]), created(createdBody)])
    try {
      const result = await c.handler(deployContext([c.item]))

      assert.equal(result.success, true, result.message)
      const iscCalls = assertAuthenticatedFirst(assert, calls)
      assert.ok(pathOf(iscCalls[0]).startsWith(c.parentListPath), `listed ${pathOf(iscCalls[0])}`)
      assert.ok(pathOf(iscCalls[1]).startsWith(c.childPath), `listed children at ${pathOf(iscCalls[1])}`)

      const writes = writeCalls(calls)
      assert.equal(writes.length, 1)
      assert.equal(writes[0].method, 'POST')
      assert.equal(pathOf(writes[0]), c.childPath)
      for (const fragment of c.createBodyIncludes ?? []) {
        assert.ok(writes[0].body.includes(fragment), `create body missing ${fragment}: ${writes[0].body}`)
      }

      const entries = entriesOf(result)
      assert.equal(entries.length, 1, 'deploy must record what it created')
      assert.equal(entries[0].existed, false)
      c.assertCreatedEntry(entries[0])
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: updates the child that exists and records the LIVE prior`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([c.parent]), listPage([c.live]), ok({})])
    try {
      const result = await c.handler(deployContext([c.item]))

      assert.equal(result.success, true, result.message)
      const writes = writeCalls(calls)
      assert.equal(writes.length, 1)
      assert.equal(writes[0].method, c.updateMethod)
      assert.equal(pathOf(writes[0]), c.updatePath)
      assert.equal(callsWithMethod(calls, 'POST').length, 0, 'must not create a child that already exists')
      for (const fragment of c.updateBodyIncludes ?? []) {
        assert.ok(writes[0].body.includes(fragment), `update body missing ${fragment}: ${writes[0].body}`)
      }

      const entries = entriesOf(result)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].existed, true)
      c.assertPrior(entries[0])
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: reports a rejected write as a failed result rather than throwing`, async () => {
    const { restore } = recordFetch([
      TOKEN,
      listPage([c.parent]),
      listPage([]),
      iscError(400, 'the request was rejected'),
    ])
    try {
      const result = await c.handler(deployContext([c.item]))

      assert.equal(result.success, false)
      assert.ok(result.message.includes('the request was rejected'), result.message)
      assert.ok(result.rollbackData, 'a failed deploy must still hand back whatever it captured')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: deletes the child it created previously and no longer declares`, async () => {
    const { calls, restore } = recordFetch([
      TOKEN,
      listPage([c.parent]),
      listPage([]),
      created(createdBody),
      NO_CONTENT,
    ])
    try {
      const result = await c.handler(
        deployContext([c.item], { priorRollbackData: { entries: [c.reconcile.priorEntry] } }),
      )

      assert.equal(result.success, true, result.message)
      const deletes = callsWithMethod(calls, 'DELETE')
      assert.equal(deletes.length, 1, 'expected exactly one reconcile delete')
      assert.equal(pathOf(deletes[0]), c.reconcile.deletePath)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: never puts the token or the client secret in its result`, async () => {
    const { restore } = recordFetch([TOKEN, listPage([c.parent]), listPage([c.live]), ok({})])
    try {
      const result = await c.handler(deployContext([c.item]))
      assert.equal(leaksSecret(result), false)
    } finally {
      restore()
    }
  })
}

// --- driftDetect --------------------------------------------------------------

export interface NestedDriftContract {
  label: string
  handler: (ctx: DriftContext) => Promise<DriftResult>
  parentListPath: string
  parent: Record<string, unknown>
  childPath: string
  item: CanvasItemSnapshot
  /** A live child matching `item` in every tracked field. */
  matchingLive: Record<string, unknown>
  /** A live child differing from `item` in one tracked field. */
  driftedLive: Record<string, unknown>
  driftedField: string
  /** The `field` reported when the child is missing from its parent. */
  absentField: string
  /** The `actual` reported when the PARENT itself is missing, e.g. 'role absent'. */
  parentAbsentActual: string
}

export function registerNestedDriftContract(c: NestedDriftContract): void {
  test(`${c.label} driftDetect: makes no ISC call at all without a credential`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(driftContext([c.item], { credential: null }))

      assert.deepEqual(result.diffs, [])
      assert.equal(calls.length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports no drift when the live child matches`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([c.parent]), listPage([c.matchingLive])])
    try {
      const result = await c.handler(driftContext([c.item]))

      assert.deepEqual(result.diffs, [])
      assert.equal(result.hasDrift, false)
      const iscCalls = assertAuthenticatedFirst(assert, calls)
      assert.ok(pathOf(iscCalls[0]).startsWith(c.parentListPath))
      assert.ok(pathOf(iscCalls[1]).startsWith(c.childPath))
      assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports the field someone changed in the tenant`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([c.parent]), listPage([c.driftedLive])])
    try {
      const result = await c.handler(driftContext([c.item]))

      assert.equal(result.hasDrift, true)
      assert.ok(
        result.diffs.some((d) => d.field === c.driftedField),
        `expected a diff for ${c.driftedField}, got ${result.diffs.map((d) => d.field).join(', ') || '(none)'}`,
      )
      assert.equal(writeCalls(calls).length, 0)
      assert.equal(leaksSecret(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports a declared child the parent no longer has`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([c.parent]), listPage([])])
    try {
      const result = await c.handler(driftContext([c.item]))

      assert.equal(result.hasDrift, true)
      const absent = result.diffs.find((d) => d.field === c.absentField)
      assert.ok(absent, `expected a diff for ${c.absentField}`)
      assert.equal(absent.actual, 'absent')
      assert.equal(absent.severity, 'critical')
      assert.equal(writeCalls(calls).length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports the parent itself being gone`, async () => {
    const { calls, restore } = recordFetch([TOKEN, listPage([])])
    try {
      const result = await c.handler(driftContext([c.item]))

      assert.equal(result.hasDrift, true)
      const diff = result.diffs.find((d) => d.field === c.absentField)
      assert.ok(diff, `expected a diff for ${c.absentField}`)
      assert.equal(diff.actual, c.parentAbsentActual)
      assert.equal(diff.severity, 'critical')
      assert.equal(writeCalls(calls).length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: a failed PARENT listing is not reported as the children being deleted`, async () => {
    const { calls, restore } = recordFetch([TOKEN, iscError(500, 'upstream failure')])
    try {
      const result = await c.handler(driftContext([c.item]))

      assert.equal(
        result.diffs.filter((d) => d.actual === 'absent').length,
        0,
        'an unreadable tenant is not the same as a deleted child',
      )
      assert.equal(writeCalls(calls).length, 0)
    } finally {
      restore()
    }
  })
}
