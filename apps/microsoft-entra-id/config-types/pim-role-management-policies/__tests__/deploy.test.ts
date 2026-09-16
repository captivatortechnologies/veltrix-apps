// ============================================================================
// deploy for PIM role management policies (activation rules), against a fake
// Microsoft Graph.
//
// These rules are the conditions an eligible admin must satisfy to ACTIVATE a
// privileged role: MFA, justification, ticketing, approval and how long the
// activation lasts. Nothing here is ever created or deleted — the rules are
// system-provisioned per scope+role — so every write is a PATCH onto a live
// object, and the three things worth asserting are that each rule body carries
// its `@odata.type` and id (Graph rejects it otherwise), that the approval
// rule MERGES into the live setting so the tenant's approver stages survive,
// and that the prior bodies recorded for rollback are the LIVE ones.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  deployContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const POLICIES = '/policies/roleManagementPolicies'
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10'

const ENABLEMENT = 'Enablement_EndUser_Assignment'
const EXPIRATION = 'Expiration_EndUser_Assignment'
const APPROVAL = 'Approval_EndUser_Assignment'

const ROLE_DEFS = /\/roleManagement\/directory\/roleDefinitions\?/
const ASSIGNMENTS = /\/policies\/roleManagementPolicyAssignments/
const RULE_PATCH = /\/roleManagementPolicies\/[^/]+\/rules\/[^/]+$/
const RULES_LIST = /\/roleManagementPolicies\/[^/]+\/rules$/

/** The tenant's own approval configuration — approver stages this app must not drop. */
const LIVE_APPROVAL_SETTING = {
  isApprovalRequired: false,
  isApprovalRequiredForExtension: false,
  approvalStages: [
    {
      approvalStageTimeOutInDays: 1,
      primaryApprovers: [{ '@odata.type': '#microsoft.graph.singleUser', userId: 'u-approver' }],
    },
  ],
}

/** The live rules of a freshly provisioned, wide-open policy. */
function liveRules(over: { enablement?: unknown; expiration?: unknown; approval?: unknown } = {}) {
  return collection([
    over.enablement ?? {
      id: ENABLEMENT,
      '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyEnablementRule',
      enabledRules: [],
    },
    over.expiration ?? {
      id: EXPIRATION,
      '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyExpirationRule',
      isExpirationRequired: false,
      maximumDuration: 'PT8H',
    },
    over.approval ?? {
      id: APPROVAL,
      '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyApprovalRule',
      setting: LIVE_APPROVAL_SETTING,
    },
  ])
}

/** A hardened activation policy: MFA + justification, 4h cap, approval required. */
function policyItem(fields: Record<string, unknown> = {}) {
  return item('Global Administrator activation', {
    roleDefinitionId: GLOBAL_ADMIN,
    requireMfaOnActivation: true,
    requireJustificationOnActivation: true,
    requireTicketingOnActivation: false,
    requireApprovalToActivate: true,
    activationExpirationRequired: true,
    activationMaximumDuration: 'PT4H',
    ...fields,
  })
}

/** The happy-path route table: role map, policy assignment, rules, rule PATCHes. */
function happyRoutes() {
  return [
    { url: RULE_PATCH, method: 'PATCH', respond: NO_CONTENT },
    { url: RULES_LIST, method: 'GET', respond: liveRules() },
    { url: ASSIGNMENTS, respond: collection([{ policyId: 'pol-1', roleDefinitionId: GLOBAL_ADMIN }]) },
    { url: ROLE_DEFS, respond: collection([{ id: GLOBAL_ADMIN, displayName: 'Global Administrator' }]) },
  ]
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([policyItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call, not half way through.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([policyItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('an unresolvable role name fails the item without writing anything', async () => {
  const { calls, restore } = routeFetch([{ url: ROLE_DEFS, respond: collection([]) }])
  try {
    const result = await deploy(deployContext([policyItem({ roleDefinitionId: 'Ghost Role' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Ghost Role: unknown role/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a rule PATCH aimed at a guessed role would relax activation on the wrong one',
    )
  } finally {
    restore()
  }
})

test('a role with no Directory-scope policy fails the item without writing anything', async () => {
  const { calls, restore } = routeFetch([
    { url: ASSIGNMENTS, respond: collection([]) },
    { url: ROLE_DEFS, respond: collection([{ id: GLOBAL_ADMIN, displayName: 'Global Administrator' }]) },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /no Directory-scope role management policy found/)
    assert.equal(writeCalls(calls).length, 0)

    // The lookup is pinned to the Directory scope: an app-scope policy for the
    // same role governs something else entirely.
    const lookup = calls.find((c) => ASSIGNMENTS.test(c.url))
    assert.ok(lookup)
    const filter = decodeURIComponent(lookup.url)
    assert.match(filter, /scopeType eq 'Directory'/)
    assert.match(filter, /scopeId eq '\/'/)
    assert.match(filter, new RegExp(`roleDefinitionId eq '${GLOBAL_ADMIN}'`))
  } finally {
    restore()
  }
})

test('a failed rules listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: RULES_LIST, method: 'GET', respond: graphError(403, 'Insufficient privileges to complete the operation.') },
    { url: ASSIGNMENTS, respond: collection([{ policyId: 'pol-1', roleDefinitionId: GLOBAL_ADMIN }]) },
    { url: ROLE_DEFS, respond: collection([{ id: GLOBAL_ADMIN, displayName: 'Global Administrator' }]) },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'the approval rule is built by MERGING the live setting — without it the stages would be wiped',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and PATCHes the three activation rules with exact bodies', async () => {
  const { calls, restore } = routeFetch(happyRoutes())
  try {
    const result = await deploy(deployContext([policyItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls[0].method, 'GET', 'the live rules are read before any of them is rewritten')

    const writes = writeCalls(calls)
    assert.deepEqual(
      writes.map((c) => `${c.method} ${c.url.replace(/^.*\/v1\.0/, '')}`),
      [
        `PATCH ${POLICIES}/pol-1/rules/${ENABLEMENT}`,
        `PATCH ${POLICIES}/pol-1/rules/${EXPIRATION}`,
        `PATCH ${POLICIES}/pol-1/rules/${APPROVAL}`,
      ],
    )

    // Every rule body must carry its @odata.type and id — Graph rejects a
    // bare property bag on these union-typed rules.
    assert.deepEqual(bodyOf(writes[0]), {
      '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyEnablementRule',
      id: ENABLEMENT,
      enabledRules: ['MultiFactorAuthentication', 'Justification'],
    })
    assert.deepEqual(bodyOf(writes[1]), {
      '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyExpirationRule',
      id: EXPIRATION,
      isExpirationRequired: true,
      maximumDuration: 'PT4H',
    })
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('the approval rule merges into the LIVE setting, preserving the tenant\'s approver stages', async () => {
  const { calls, restore } = routeFetch(happyRoutes())
  try {
    await deploy(deployContext([policyItem()]))

    const approval = writeCalls(calls).find((c) => c.url.endsWith(APPROVAL))
    assert.ok(approval)
    assert.deepEqual(bodyOf(approval), {
      '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyApprovalRule',
      id: APPROVAL,
      setting: {
        ...LIVE_APPROVAL_SETTING,
        // Only this one key is this app's to set; replacing the whole setting
        // would silently delete the configured approvers.
        isApprovalRequired: true,
      },
    })
  } finally {
    restore()
  }
})

test('every activation requirement the canvas switches off is sent off, not omitted', async () => {
  const { calls, restore } = routeFetch(happyRoutes())
  try {
    await deploy(
      deployContext([
        policyItem({
          requireMfaOnActivation: false,
          requireJustificationOnActivation: false,
          requireApprovalToActivate: false,
          activationExpirationRequired: false,
          activationMaximumDuration: '',
        }),
      ]),
    )

    const writes = writeCalls(calls)
    // An empty enabledRules IS the declared state — but it is also the state
    // that removes MFA from a Global Administrator activation, so it must only
    // ever come from the canvas saying so.
    assert.deepEqual(bodyOf(writes[0])?.enabledRules, [])
    assert.deepEqual(bodyOf(writes[1]), {
      '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyExpirationRule',
      id: EXPIRATION,
      isExpirationRequired: false,
    })
    assert.equal((bodyOf(writes[2])?.setting as { isApprovalRequired: boolean }).isApprovalRequired, false)
  } finally {
    restore()
  }
})

test('ticketing is added to enabledRules only when the canvas asks for it', async () => {
  const { calls, restore } = routeFetch(happyRoutes())
  try {
    await deploy(deployContext([policyItem({ requireTicketingOnActivation: true })]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.enabledRules, [
      'MultiFactorAuthentication',
      'Justification',
      'Ticketing',
    ])
  } finally {
    restore()
  }
})

test('deploy records the LIVE prior rule bodies, not the ones it just sent', async () => {
  const { calls, restore } = routeFetch(happyRoutes())
  try {
    const result = await deploy(deployContext([policyItem()]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true, 'PIM rules are system-provisioned — never created by this app')
    assert.equal(entries[0].policyId, 'pol-1')
    // Rollback has to put back what the tenant HAD: no MFA, 8h cap, no approval.
    assert.deepEqual(entries[0].priorRules, {
      [ENABLEMENT]: {
        '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyEnablementRule',
        id: ENABLEMENT,
        enabledRules: [],
      },
      [EXPIRATION]: {
        '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyExpirationRule',
        id: EXPIRATION,
        isExpirationRequired: false,
        maximumDuration: 'PT8H',
      },
      [APPROVAL]: {
        '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyApprovalRule',
        id: APPROVAL,
        setting: LIVE_APPROVAL_SETTING,
      },
    })
    const prior = entries[0].priorRules as Record<string, unknown>
    assert.notDeepEqual(prior[ENABLEMENT], bodyOf(writeCalls(calls)[0]))
  } finally {
    restore()
  }
})

test('a policy whose rules are missing is snapshotted with safe defaults, never undefined', async () => {
  const { restore } = routeFetch([
    { url: RULE_PATCH, method: 'PATCH', respond: NO_CONTENT },
    { url: RULES_LIST, method: 'GET', respond: collection([]) },
    { url: ASSIGNMENTS, respond: collection([{ policyId: 'pol-1', roleDefinitionId: GLOBAL_ADMIN }]) },
    { url: ROLE_DEFS, respond: collection([{ id: GLOBAL_ADMIN, displayName: 'Global Administrator' }]) },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    const entries = (result.rollbackData as { entries: Array<{ priorRules: Record<string, unknown> }> }).entries
    // An undefined here would be dropped by JSON.stringify and rollback would
    // silently leave the deployed rule in place.
    assert.deepEqual(entries[0].priorRules[EXPIRATION], {
      '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyExpirationRule',
      id: EXPIRATION,
      isExpirationRequired: false,
      maximumDuration: 'PT8H',
    })
    assert.deepEqual(entries[0].priorRules[APPROVAL], {
      '@odata.type': '#microsoft.graph.unifiedRoleManagementPolicyApprovalRule',
      id: APPROVAL,
      setting: { isApprovalRequired: false },
    })
  } finally {
    restore()
  }
})

test('a rejected rule PATCH stops the remaining rules for that role and records no entry', async () => {
  const { calls, restore } = routeFetch([
    {
      url: RULE_PATCH,
      method: 'PATCH',
      respond: graphError(400, 'The enablement rule cannot be modified for this role.', 'Request_BadRequest'),
    },
    { url: RULES_LIST, method: 'GET', respond: liveRules() },
    { url: ASSIGNMENTS, respond: collection([{ policyId: 'pol-1', roleDefinitionId: GLOBAL_ADMIN }]) },
    { url: ROLE_DEFS, respond: collection([{ id: GLOBAL_ADMIN, displayName: 'Global Administrator' }]) },
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), new RegExp(`${ENABLEMENT}`))
    assert.match(String(result.message), /cannot be modified/)
    assert.equal(
      writeCalls(calls).length,
      1,
      'a half-applied activation policy is worse than none — the rest of the rules are not attempted',
    )
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a role dropped from the canvas is left exactly as last set — these rules are never deleted', async () => {
  const { calls, restore } = routeFetch(happyRoutes())
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [{ name: GLOBAL_ADMIN, existed: true, policyId: 'pol-1', priorRules: {} }],
        },
      }),
    )

    assert.equal(
      writeCalls(calls).length,
      0,
      'PIM rules are system-provisioned per scope+role — there is nothing to reconcile away',
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 role\(s\)/)
  } finally {
    restore()
  }
})
