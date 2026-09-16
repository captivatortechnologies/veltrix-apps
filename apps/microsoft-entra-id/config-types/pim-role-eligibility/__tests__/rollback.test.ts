// ============================================================================
// rollback for PIM role eligibility, against a fake Microsoft Graph.
//
// PIM has no delete and no patch: every reversal is ANOTHER
// unifiedRoleEligibilityScheduleRequest, so the `action` on the wire is the
// whole safety story. An eligibility this deploy granted is revoked with
// adminRemove; one that already existed is left alone; one whose WINDOW this
// deploy changed is put back with adminUpdate carrying the recorded prior
// expiration. Revoking the wrong one strips an administrator of standing
// privilege the tenant granted long before Veltrix existed.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  graphError,
  leaksSecret,
  recordFetch,
  rollbackContext,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const REQUESTS = '/roleManagement/directory/roleEligibilityScheduleRequests'
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10'
const ADA = '071cc716-8147-4397-a5ba-b2105951cc0b'
const BOB = 'b0b0b0b0-1111-2222-3333-444444444444'

function entry(over: Record<string, unknown> = {}) {
  return {
    name: `${GLOBAL_ADMIN} → ${ADA} @ /`,
    principalId: ADA,
    roleDefinitionId: GLOBAL_ADMIN,
    directoryScopeId: '/',
    action: 'adminAssign',
    existed: false,
    ...over,
  }
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [entry()] }, { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback revokes the eligibility this deploy granted, with no scheduleInfo', async () => {
  const { calls, restore } = recordFetch([TOKEN, created({ id: 'req-1', status: 'Provisioned' })])
  try {
    const result = await rollback(rollbackContext({ entries: [entry()] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'POST')
    assert.ok(graphCalls[0].url.endsWith(REQUESTS))
    // A revocation carries no window — sending one would re-assert the grant.
    assert.deepEqual(bodyOf(graphCalls[0]), {
      action: 'adminRemove',
      principalId: ADA,
      roleDefinitionId: GLOBAL_ADMIN,
      directoryScopeId: '/',
      justification: 'Reverted by Veltrix config as code',
    })
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 revoked, 0 restored/)
  } finally {
    restore()
  }
})

test('an eligibility that already existed is NEVER revoked by a rollback', async () => {
  const { calls, restore } = routeFetch([
    { url: /roleEligibilityScheduleRequests/, method: 'POST', respond: created({ status: 'Provisioned' }) },
  ])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          entry({ name: 'theirs', principalId: BOB, existed: true }),
          entry({ name: 'ours', existed: false }),
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(bodyOf(writes[0])?.principalId, ADA)
    assert.ok(
      !writes.some((c) => bodyOf(c)?.principalId === BOB),
      'undoing our deploy must not revoke privilege the tenant granted itself',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback restores the prior eligibility window with an adminUpdate', async () => {
  const PRIOR = { type: 'afterDuration', duration: 'P365D' }
  const { calls, restore } = recordFetch([TOKEN, created({ id: 'req-1', status: 'Provisioned' })])
  try {
    const result = await rollback(
      rollbackContext({ entries: [entry({ action: 'adminUpdate', existed: true, priorExpiration: PRIOR })] }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.deepEqual(bodyOf(writes[0]), {
      action: 'adminUpdate',
      principalId: ADA,
      roleDefinitionId: GLOBAL_ADMIN,
      directoryScopeId: '/',
      justification: 'Reverted by Veltrix config as code',
      // The window the TENANT had, verbatim — not a recomputed default.
      scheduleInfo: { expiration: PRIOR },
    })
    assert.match(String(result.message), /0 revoked, 1 restored/)
  } finally {
    restore()
  }
})

test('an adminUpdate with no recorded prior window is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [entry({ action: 'adminUpdate', existed: true })] }))

    assert.equal(
      writeCalls(calls).length,
      0,
      'guessing noExpiration here would turn a time-bound eligibility into standing privilege',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a carried entry — a deploy that changed nothing — is skipped entirely', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [entry({ carried: true })] }))

    assert.equal(calls.length, 0, 'there is nothing to reverse for an eligibility this deploy did not touch')
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 revoked, 0 restored/)
  } finally {
    restore()
  }
})

test('rollback does nothing when the deploy recorded no entries', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback reports a rejected request rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(rollbackContext({ entries: [entry()] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback had errors/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
