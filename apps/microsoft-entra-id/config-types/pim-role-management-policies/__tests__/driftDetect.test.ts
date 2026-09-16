// ============================================================================
// driftDetect for PIM role activation policies.
//
// The drift worth catching is someone relaxing activation for a privileged role
// in the portal: MFA turned off, approval no longer required, the maximum
// activation duration stretched. Each is a different rule object under the
// role's policy, and the policy itself is not addressed by the role id — it is
// reached through a roleManagementPolicyAssignments lookup, so the read path is
// three hops and every one of them can fail to resolve.
//
// A role named in the canvas that no longer exists is CRITICAL, not a silent
// pass: it means the deployed requirement is protecting nothing.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  resource,
  routeFetch,
  TOKEN,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const ROLE_ID = '62e90394-69f5-4237-9190-012177145e10'
const ROLE_NAME = 'Global Administrator'
const POLICY_ID = 'DirectoryRole_7b2f0c11_policy'

const ENABLEMENT = 'Enablement_EndUser_Assignment'
const EXPIRATION = 'Expiration_EndUser_Assignment'
const APPROVAL = 'Approval_EndUser_Assignment'

const ROLE_DEFS = /\/roleManagement\/directory\/roleDefinitions/
const ASSIGNMENTS = /\/policies\/roleManagementPolicyAssignments/
const RULES = /\/policies\/roleManagementPolicies\/.+\/rules/

/** The deployed canvas: MFA and justification required, 4h cap, no approval. */
function pimItem(fields: Record<string, unknown> = {}) {
  return item('Global Administrator activation', {
    roleDefinitionId: ROLE_ID,
    requireMfaOnActivation: true,
    requireJustificationOnActivation: true,
    requireTicketingOnActivation: false,
    requireApprovalToActivate: false,
    activationExpirationRequired: true,
    activationMaximumDuration: 'PT4H',
    ...fields,
  })
}

/** Live rules matching the canvas above. */
function liveRules(over: { enabled?: string[]; expiration?: unknown; approval?: boolean } = {}) {
  return collection([
    { id: ENABLEMENT, enabledRules: over.enabled ?? ['MultiFactorAuthentication', 'Justification'] },
    (over.expiration as Record<string, unknown>) ?? {
      id: EXPIRATION,
      isExpirationRequired: true,
      maximumDuration: 'PT4H',
    },
    { id: APPROVAL, setting: { isApprovalRequired: over.approval === true } },
  ])
}

function routes(over: { roles?: unknown; assignment?: unknown; rules?: unknown } = {}) {
  return [
    {
      url: ROLE_DEFS,
      respond: (over.roles as never) ?? collection([{ id: ROLE_ID, displayName: ROLE_NAME }]),
    },
    {
      url: ASSIGNMENTS,
      respond: (over.assignment as never) ?? resource({ value: [{ policyId: POLICY_ID }] }),
    },
    { url: RULES, respond: (over.rules as never) ?? liveRules() },
  ]
}

test('makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([pimItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('reports no drift when the live rules match what was deployed', async () => {
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await driftDetect(driftContext([pimItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('MFA turned off in the portal surfaces', async () => {
  const { restore } = routeFetch(routes({ rules: liveRules({ enabled: ['Justification'] }) }))
  try {
    const result = await driftDetect(driftContext([pimItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: `${ROLE_ID}.enabledRules`,
        expected: 'Justification,MultiFactorAuthentication',
        actual: 'Justification',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('the same requirements listed in another order are not drift', async () => {
  const { restore } = routeFetch(
    routes({ rules: liveRules({ enabled: ['Justification', 'MultiFactorAuthentication'] }) }),
  )
  try {
    const result = await driftDetect(driftContext([pimItem()]))

    // Graph does not promise an order for enabledRules, so comparing raw would
    // report drift on every scheduled run for a tenant nobody has touched.
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('every requirement removed reads as "(none)", not as an empty field name', async () => {
  const { restore } = routeFetch(routes({ rules: liveRules({ enabled: [] }) }))
  try {
    const result = await driftDetect(driftContext([pimItem()]))

    assert.equal(
      result.diffs.find((d) => d.field === `${ROLE_ID}.enabledRules`)?.actual,
      '(none)',
      'an empty actual in a drift report reads as a rendering bug, not as a finding',
    )
  } finally {
    restore()
  }
})

test('an activation window stretched in the portal surfaces', async () => {
  const { restore } = routeFetch(
    routes({ rules: liveRules({ expiration: { id: EXPIRATION, isExpirationRequired: true, maximumDuration: 'PT12H' } }) }),
  )
  try {
    const result = await driftDetect(driftContext([pimItem()]))

    assert.deepEqual(result.diffs, [
      { field: `${ROLE_ID}.maximumDuration`, expected: 'PT4H', actual: 'PT12H', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('expiry no longer required surfaces even though the duration still matches', async () => {
  const { restore } = routeFetch(
    routes({
      rules: liveRules({ expiration: { id: EXPIRATION, isExpirationRequired: false, maximumDuration: 'PT4H' } }),
    }),
  )
  try {
    const result = await driftDetect(driftContext([pimItem()]))

    // A permanent activation is the finding; the cap next to it is irrelevant
    // once nothing enforces an expiry at all.
    assert.deepEqual(result.diffs, [
      { field: `${ROLE_ID}.isExpirationRequired`, expected: 'true', actual: 'false', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('approval turned on in the portal surfaces', async () => {
  const { restore } = routeFetch(routes({ rules: liveRules({ approval: true }) }))
  try {
    const result = await driftDetect(driftContext([pimItem()]))

    assert.deepEqual(result.diffs, [
      { field: `${ROLE_ID}.isApprovalRequired`, expected: 'false', actual: 'true', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('a missing approval rule reads as "not required", not as absent', async () => {
  const { restore } = routeFetch(
    routes({
      rules: collection([
        { id: ENABLEMENT, enabledRules: ['MultiFactorAuthentication', 'Justification'] },
        { id: EXPIRATION, isExpirationRequired: true, maximumDuration: 'PT4H' },
      ]),
    }),
  )
  try {
    const result = await driftDetect(driftContext([pimItem()]))

    // The canvas asked for no approval and the tenant has no approval rule —
    // that is agreement, not a hole to report.
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('a role named in the canvas that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch(routes({ roles: collection([]) }))
  try {
    const result = await driftDetect(driftContext([pimItem({ roleDefinitionId: 'Privileged Role Administrator' })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Privileged Role Administrator',
        expected: 'resolvable',
        actual: 'unknown role: Privileged Role Administrator',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})

test('a role named rather than given by id is resolved and compared', async () => {
  const { restore } = routeFetch(routes({ rules: liveRules({ enabled: ['Justification'] }) }))
  try {
    const result = await driftDetect(driftContext([pimItem({ roleDefinitionId: ROLE_NAME })]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].field, `${ROLE_NAME}.enabledRules`, 'the report names what the author wrote')
  } finally {
    restore()
  }
})

test('a role with no PIM policy assignment is critical drift', async () => {
  const { restore } = routeFetch(routes({ assignment: resource({ value: [] }) }))
  try {
    const result = await driftDetect(driftContext([pimItem()]))

    // The deployed requirement is governing nothing, which an operator has to
    // be told about — it is not the same as "the rules still match".
    assert.deepEqual(result.diffs, [
      { field: ROLE_ID, expected: 'policy present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('an item with no role named is skipped entirely', async () => {
  const { restore } = routeFetch(routes())
  try {
    const result = await driftDetect(driftContext([pimItem({ roleDefinitionId: '' })]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('a failed rules read writes nothing', async () => {
  const { calls, restore } = routeFetch(routes({ rules: graphError(500, 'Service unavailable') }))
  try {
    const result = await driftDetect(driftContext([pimItem()]))

    // NOTE: the handler skips the role and reports `hasDrift: false`, which the
    // platform reads as "checked and in sync". `DriftResult.checked` exists for
    // this case; adopting it across the catalog is tracked separately. What is
    // unambiguously right today, and pinned here: a transient failure is never
    // announced as "every activation requirement was removed".
    assert.equal(writeCalls(calls).length, 0)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('several roles are each compared', async () => {
  const OTHER_ID = '194ae4cb-b126-40b2-bd5b-6091b380977d'
  const { restore } = routeFetch([
    {
      url: ROLE_DEFS,
      respond: collection([
        { id: ROLE_ID, displayName: ROLE_NAME },
        { id: OTHER_ID, displayName: 'User Administrator' },
      ]),
    },
    { url: ASSIGNMENTS, respond: resource({ value: [{ policyId: POLICY_ID }] }) },
    { url: RULES, respond: liveRules({ enabled: ['Justification'] }) },
  ])
  try {
    const result = await driftDetect(
      driftContext([pimItem(), pimItem({ roleDefinitionId: OTHER_ID })]),
    )

    assert.deepEqual(
      result.diffs.map((d) => d.field),
      [`${ROLE_ID}.enabledRules`, `${OTHER_ID}.enabledRules`],
    )
  } finally {
    restore()
  }
})

test('diffs carry no token and no client secret', async () => {
  const { restore } = routeFetch(routes({ rules: liveRules({ enabled: [] }) }))
  try {
    const result = await driftDetect(driftContext([pimItem()]))

    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
