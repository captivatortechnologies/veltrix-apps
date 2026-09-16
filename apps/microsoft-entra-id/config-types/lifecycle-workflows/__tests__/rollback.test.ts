// ============================================================================
// rollback for Entra lifecycle workflows, against a fake Microsoft Graph.
//
// A lifecycle workflow runs on a schedule and changes people's access without
// anyone pressing anything, so "put it back" has to mean the live `isEnabled`,
// `isSchedulingEnabled`, conditions and tasks deploy recorded. A workflow this
// deploy created is deleted outright; one that pre-existed is restored, never
// deleted, and never reconstructed from the canvas the rollback is undoing.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  graphError,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  rollbackContext,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

/** What deploy snapshots off the LIVE workflow before it overwrites it. */
const PRIOR = {
  displayName: 'Offboard leaver',
  description: 'Old description',
  isEnabled: false,
  isSchedulingEnabled: false,
  executionConditions: { '@odata.type': '#microsoft.graph.identityGovernance.triggerAndScopeBasedConditions' },
  tasks: [],
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Offboard leaver', existed: false, id: 'wf-1' }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the LIVE prior state captured at deploy, disabled flags included', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Offboard leaver', existed: true, id: 'wf-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith('/identityGovernance/lifecycleWorkflows/workflows/wf-1'))
    // Leaving isEnabled/isSchedulingEnabled true here would keep a workflow
    // running that the tenant never had armed before the deploy.
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a workflow the deploy created and leaves a pre-existing one alone', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({})])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'New workflow', existed: false, id: 'wf-new' },
          { name: 'Offboard leaver', existed: true, id: 'wf-1', prior: PRIOR },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/workflows/wf-new'))
    assert.equal(writes[1].method, 'PATCH', 'a workflow that pre-dated this deploy is never deleted')
    assert.ok(writes[1].url.endsWith('/workflows/wf-1'))
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('a workflow already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'New workflow', existed: false, id: 'wf-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('an updated workflow with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Offboard leaver', existed: true, id: 'wf-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, 'no prior means nothing safe to write')
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('an entry with no recorded id is skipped rather than deleting something at random', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Never created', existed: false }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([
    TOKEN,
    graphError(402, 'Tenant is not licensed for Microsoft Entra ID Governance.', 'NotLicensed'),
  ])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Offboard leaver', existed: true, id: 'wf-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /restore Offboard leaver/)
    assert.match(String(result.message), /not licensed/i)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('rollback does nothing when the deploy recorded no rollbackData at all', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing to undo means the vendor is never called')
  } finally {
    restore()
  }
})
