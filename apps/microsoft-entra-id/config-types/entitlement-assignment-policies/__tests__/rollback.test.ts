// ============================================================================
// rollback for Entra access-package assignment policies, against a fake
// Microsoft Graph.
//
// This is the handler that has to put an ACCESS DECISION back. The prior state
// deploy recorded is the live `allowedTargetScope`, `specificAllowedTargets`,
// `requestorSettings` and `requestApprovalSettings` — restore anything else and
// the tenant is left with an audience or an approval chain it never chose.
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

const APPROVER_GROUP_GUID = '22222222-2222-2222-2222-222222222222'

/**
 * What deploy snapshots off the LIVE policy before it overwrites it — a
 * narrower policy than the one the deploy was about to write: only a named
 * group may request, and a named group has to approve.
 */
const PRIOR = {
  displayName: 'Standard',
  description: 'Old description',
  allowedTargetScope: 'specificDirectoryUsers',
  expiration: { type: 'afterDuration', duration: 'P90D' },
  specificAllowedTargets: [
    { '@odata.type': '#microsoft.graph.groupMembers', groupId: APPROVER_GROUP_GUID },
  ],
  requestorSettings: { enableTargetsToSelfAddAccess: false, onBehalfRequestors: [] },
  requestApprovalSettings: {
    isApprovalRequiredForAdd: true,
    isRequestorJustificationRequired: true,
    stages: [
      {
        '@odata.type': '#microsoft.graph.accessPackageApprovalStage',
        primaryApprovers: [{ '@odata.type': '#microsoft.graph.groupMembers', groupId: APPROVER_GROUP_GUID }],
      },
    ],
  },
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Standard', existed: false, id: 'pol-1' }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the LIVE prior access decision captured at deploy', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Standard', existed: true, id: 'pol-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(
      graphCalls[0].url.endsWith('/identityGovernance/entitlementManagement/assignmentPolicies/pol-1'),
    )
    // Byte for byte — the audience, the requestor settings AND the approval
    // stages the tenant actually had.
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a policy the deploy created and leaves a pre-existing one alone', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({})])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'New policy', existed: false, id: 'pol-new' },
          { name: 'Standard', existed: true, id: 'pol-1', prior: PRIOR },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/assignmentPolicies/pol-new'))
    assert.equal(writes[1].method, 'PATCH', 'a policy that pre-dated this deploy is never deleted')
    assert.ok(writes[1].url.endsWith('/assignmentPolicies/pol-1'))
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('a policy already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'New policy', existed: false, id: 'pol-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('an updated policy with no recorded prior state is left alone, never guessed at', async () => {
  // Guessing here would mean re-deriving an audience from a canvas — exactly
  // the wrong source, since the canvas is what the rollback is undoing.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Standard', existed: true, id: 'pol-1' }] }))

    assert.equal(writeCalls(calls).length, 0)
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
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Standard', existed: true, id: 'pol-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /restore Standard/)
    assert.match(String(result.message), /Insufficient privileges/)
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
