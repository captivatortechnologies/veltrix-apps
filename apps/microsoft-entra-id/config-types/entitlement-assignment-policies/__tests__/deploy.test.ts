import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  ok,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy, {
  buildApprovalSettings,
  buildCreateBody,
  buildPatchBody,
  buildRequestorSettings,
  buildSpecificAllowedTargets,
  type ResolvedPolicy,
  type ResolvedTargets,
} from '../deploy'
import type { AssignmentPolicySpec } from '../validate'

const USER_ID = '11111111-1111-1111-1111-111111111111'
const GROUP_ID = '22222222-2222-2222-2222-222222222222'
const SP_ID = '33333333-3333-3333-3333-333333333333'
const CONNORG_ID = '44444444-4444-4444-4444-444444444444'
const PACKAGE_ID = '55555555-5555-5555-5555-555555555555'

const BASE_SPEC: AssignmentPolicySpec = {
  itemId: 'item-1',
  name: 'Standard',
  accessPackageId: 'Sales reps',
  description: '',
  allowedTargetScope: 'notSpecified',
  expiration: '',
  specificTargetUsers: [],
  specificTargetGroups: [],
  specificTargetServicePrincipals: [],
  specificTargetConnectedOrganizations: [],
  enableTargetsToSelfAddAccess: true,
  enableTargetsToSelfUpdateAccess: false,
  enableTargetsToSelfRemoveAccess: false,
  allowCustomAssignmentSchedule: true,
  enableOnBehalfRequestorsToAddAccess: false,
  enableOnBehalfRequestorsToUpdateAccess: false,
  enableOnBehalfRequestorsToRemoveAccess: false,
  onBehalfRequestorUsers: [],
  onBehalfRequestorGroups: [],
  onBehalfRequestorServicePrincipals: [],
  isApprovalRequiredForAdd: false,
  isApprovalRequiredForUpdate: false,
  isRequestorJustificationRequired: true,
  primaryApproverUsers: [],
  primaryApproverGroups: [],
  approvalStagesOverride: '',
}

describe('buildRequestorSettings', () => {
  it('maps each on-behalf-of kind to its subjectSet wrapper', () => {
    const settings = buildRequestorSettings(BASE_SPEC, { users: [USER_ID], groups: [GROUP_ID], servicePrincipals: [SP_ID] })
    expect(settings.onBehalfRequestors).toEqual([
      { '@odata.type': '#microsoft.graph.singleUser', userId: USER_ID },
      { '@odata.type': '#microsoft.graph.groupMembers', groupId: GROUP_ID },
      { '@odata.type': '#microsoft.graph.singleServicePrincipal', servicePrincipalId: SP_ID },
    ])
    expect(settings.enableTargetsToSelfAddAccess).toBe(true)
    expect(settings.allowCustomAssignmentSchedule).toBe(true)
  })

  it('produces an empty onBehalfRequestors array when none are set', () => {
    const settings = buildRequestorSettings(BASE_SPEC, { users: [], groups: [], servicePrincipals: [] })
    expect(settings.onBehalfRequestors).toEqual([])
  })
})

describe('buildApprovalSettings', () => {
  it('builds a single default stage from primaryApprover* fields when approval is required and no override is set', () => {
    const spec: AssignmentPolicySpec = { ...BASE_SPEC, isApprovalRequiredForAdd: true }
    const settings = buildApprovalSettings(spec, { users: [USER_ID], groups: [GROUP_ID] })
    expect(settings.stages).toEqual([
      {
        '@odata.type': '#microsoft.graph.accessPackageApprovalStage',
        isApproverJustificationRequired: false,
        isEscalationEnabled: false,
        primaryApprovers: [
          { '@odata.type': '#microsoft.graph.singleUser', userId: USER_ID },
          { '@odata.type': '#microsoft.graph.groupMembers', groupId: GROUP_ID },
        ],
      },
    ])
  })

  it('produces no stages when approval is not required', () => {
    const settings = buildApprovalSettings(BASE_SPEC, { users: [USER_ID], groups: [] })
    expect(settings.stages).toEqual([])
  })

  it('the JSON override REPLACES the typed primaryApprover* fields entirely when non-empty', () => {
    const spec: AssignmentPolicySpec = {
      ...BASE_SPEC,
      isApprovalRequiredForAdd: true,
      approvalStagesOverride: '[{"primaryApprovers":[{"@odata.type":"#microsoft.graph.requestorManager"}],"isEscalationEnabled":false}]',
    }
    const settings = buildApprovalSettings(spec, { users: [USER_ID], groups: [] })
    expect(settings.stages).toEqual([
      { primaryApprovers: [{ '@odata.type': '#microsoft.graph.requestorManager' }], isEscalationEnabled: false },
    ])
  })

  it('an empty-array override falls back to the typed single-stage build', () => {
    const spec: AssignmentPolicySpec = { ...BASE_SPEC, isApprovalRequiredForAdd: true, approvalStagesOverride: '[]' }
    const settings = buildApprovalSettings(spec, { users: [USER_ID], groups: [] })
    expect((settings.stages as unknown[]).length).toBe(1)
  })
})

describe('buildSpecificAllowedTargets', () => {
  it('maps every kind to its subjectSet wrapper', () => {
    const targets: ResolvedTargets = { users: [USER_ID], groups: [GROUP_ID], servicePrincipals: [SP_ID], connectedOrganizations: [CONNORG_ID] }
    expect(buildSpecificAllowedTargets(targets)).toEqual([
      { '@odata.type': '#microsoft.graph.singleUser', userId: USER_ID },
      { '@odata.type': '#microsoft.graph.groupMembers', groupId: GROUP_ID },
      { '@odata.type': '#microsoft.graph.singleServicePrincipal', servicePrincipalId: SP_ID },
      { '@odata.type': '#microsoft.graph.connectedOrganizationMembers', connectedOrganizationId: CONNORG_ID },
    ])
  })
})

describe('buildPatchBody / buildCreateBody', () => {
  const resolved: ResolvedPolicy = {
    specificAllowedTargets: [],
    requestorSettings: { enableTargetsToSelfAddAccess: true },
    requestApprovalSettings: { isApprovalRequiredForAdd: false, stages: [] },
  }

  it('PATCH body carries every managed field, never the access package binding', () => {
    const body = buildPatchBody(BASE_SPEC, resolved)
    expect(body).toEqual({
      displayName: 'Standard',
      description: '',
      allowedTargetScope: 'notSpecified',
      expiration: {},
      specificAllowedTargets: [],
      requestorSettings: { enableTargetsToSelfAddAccess: true },
      requestApprovalSettings: { isApprovalRequiredForAdd: false, stages: [] },
    })
    expect(body.accessPackage).toBeUndefined()
  })

  it('POST body additionally binds the access package by id only', () => {
    const body = buildCreateBody(BASE_SPEC, resolved, PACKAGE_ID)
    expect(body.accessPackage).toEqual({ id: PACKAGE_ID })
  })
})

// ============================================================================
// deploy, end to end against a fake Microsoft Graph.
//
// Everything above tests the exported builders in isolation. What follows
// drives the DEFAULT export — the handler that writes the policies deciding WHO
// may request an access package and WHO has to approve it.
//
// Two mistakes here hand out standing access to a directory: an
// `allowedTargetScope` that widens to "all member users", and a
// `requestApprovalSettings` that loses its stages so every request
// auto-approves. Both are single values on the wire, so every assertion below
// is on the actual request body, and the parallel display-name -> id listings
// are fixtured by URL (routeFetch) rather than by a call ORDER `Promise.all`
// does not guarantee.
// ============================================================================

const POLICY_BY_ID = /assignmentPolicies\/[^/?]+$/
const POLICY_CREATE = /assignmentPolicies$/
const POLICY_LIST = /assignmentPolicies\?/
const PACKAGE_MAP = /entitlementManagement\/accessPackages\?/
const USER_MAP = /\/users\?/
const GROUP_MAP = /\/groups\?/
const SP_MAP = /servicePrincipals\?/
const CONNORG_MAP = /connectedOrganizations\?/

const PACKAGE_GUID = '55555555-5555-5555-5555-555555555555'
const REQUESTOR_GUID = '11111111-1111-1111-1111-111111111111'
const APPROVER_GROUP_GUID = '22222222-2222-2222-2222-222222222222'

/** The subjectSet a resolved approver group becomes on the wire. */
const APPROVER_SUBJECT = { '@odata.type': '#microsoft.graph.groupMembers', groupId: APPROVER_GROUP_GUID }
/** The subjectSet the single allowed requestor becomes on the wire. */
const REQUESTOR_SUBJECT = { '@odata.type': '#microsoft.graph.singleUser', userId: REQUESTOR_GUID }

/** Exactly the requestorSettings the canvas item below must produce. */
const EXPECTED_REQUESTOR_SETTINGS = {
  enableTargetsToSelfAddAccess: true,
  enableTargetsToSelfUpdateAccess: false,
  enableTargetsToSelfRemoveAccess: false,
  allowCustomAssignmentSchedule: true,
  enableOnBehalfRequestorsToAddAccess: false,
  enableOnBehalfRequestorsToUpdateAccess: false,
  enableOnBehalfRequestorsToRemoveAccess: false,
  onBehalfRequestors: [],
}

/** Exactly the requestApprovalSettings the canvas item below must produce. */
const EXPECTED_APPROVAL_SETTINGS = {
  isApprovalRequiredForAdd: true,
  isApprovalRequiredForUpdate: false,
  isRequestorJustificationRequired: true,
  stages: [
    {
      '@odata.type': '#microsoft.graph.accessPackageApprovalStage',
      isApproverJustificationRequired: false,
      isEscalationEnabled: false,
      primaryApprovers: [APPROVER_SUBJECT],
    },
  ],
}

function policyItem(fields: Record<string, unknown> = {}, id?: string) {
  return item(
    'Standard',
    {
      name: 'Standard',
      accessPackageId: PACKAGE_GUID,
      description: 'Standard request policy',
      allowedTargetScope: 'specificDirectoryUsers',
      specificTargetUsers: [REQUESTOR_GUID],
      isApprovalRequiredForAdd: true,
      primaryApproverGroups: [APPROVER_GROUP_GUID],
      ...fields,
    },
    id,
  )
}

/** Routes for the five parallel name maps, all empty unless a test overrides. */
function nameMapRoutes(): Array<{ url: RegExp; respond: ReturnType<typeof collection> }> {
  return [
    { url: PACKAGE_MAP, respond: collection([]) },
    { url: USER_MAP, respond: collection([]) },
    { url: GROUP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: CONNORG_MAP, respond: collection([]) },
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
  // so this must fail closed BEFORE any network call.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([policyItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed policy listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICY_LIST, method: 'GET', respond: graphError(403, 'Insufficient privileges to complete the operation.') },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list assignment policies/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live policies must not create or patch any',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first, then creates the policy with exactly the declared audience and approval', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICY_LIST, method: 'GET', respond: collection([]) },
    { url: POLICY_CREATE, method: 'POST', respond: created({ id: 'pol-new' }) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const write = graphCalls.find((c) => c.method === 'POST')
    assert.ok(write, 'expected a POST creating the assignment policy')
    assert.ok(write.url.endsWith('/identityGovernance/entitlementManagement/assignmentPolicies'))

    // The whole access decision, byte for byte: only the one named requestor
    // may ask, and the named group has to approve before anyone gets in.
    assert.deepEqual(bodyOf(write), {
      displayName: 'Standard',
      description: 'Standard request policy',
      allowedTargetScope: 'specificDirectoryUsers',
      expiration: {},
      specificAllowedTargets: [REQUESTOR_SUBJECT],
      requestorSettings: EXPECTED_REQUESTOR_SETTINGS,
      requestApprovalSettings: EXPECTED_APPROVAL_SETTINGS,
      accessPackage: { id: PACKAGE_GUID },
    })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: undefined, name: 'Standard', existed: false, id: 'pol-new' }])
    assert.equal(leaksSecret(result), false, 'the token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('a hand-typed approver name is resolved to its live id before the policy is written', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICY_LIST, method: 'GET', respond: collection([]) },
    { url: POLICY_CREATE, method: 'POST', respond: created({ id: 'pol-new' }) },
    { url: PACKAGE_MAP, respond: collection([]) },
    { url: USER_MAP, respond: collection([{ id: REQUESTOR_GUID, displayName: 'Ada Lovelace' }]) },
    { url: GROUP_MAP, respond: collection([{ id: APPROVER_GROUP_GUID, displayName: 'Access Approvers' }]) },
    { url: SP_MAP, respond: collection([]) },
    { url: CONNORG_MAP, respond: collection([]) },
  ])
  try {
    const result = await deploy(
      deployContext([
        policyItem({ specificTargetUsers: ['Ada Lovelace'], primaryApproverGroups: ['Access Approvers'] }),
      ]),
    )

    assert.equal(result.success, true)
    const body = bodyOf(writeCalls(calls)[0])
    assert.deepEqual(body?.specificAllowedTargets, [REQUESTOR_SUBJECT])
    assert.deepEqual(
      (body?.requestApprovalSettings as { stages: Array<{ primaryApprovers: unknown }> }).stages[0].primaryApprovers,
      [APPROVER_SUBJECT],
    )
  } finally {
    restore()
  }
})

test('a policy that requires no approval sends no stages, and never invents one', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICY_LIST, method: 'GET', respond: collection([]) },
    { url: POLICY_CREATE, method: 'POST', respond: created({ id: 'pol-new' }) },
    ...nameMapRoutes(),
  ])
  try {
    await deploy(
      deployContext([policyItem({ isApprovalRequiredForAdd: false, primaryApproverGroups: [] })]),
    )

    const body = bodyOf(writeCalls(calls)[0])
    assert.deepEqual(body?.requestApprovalSettings, {
      isApprovalRequiredForAdd: false,
      isApprovalRequiredForUpdate: false,
      isRequestorJustificationRequired: true,
      stages: [],
    })
  } finally {
    restore()
  }
})

test('self-service add access is sent exactly as declared, not left at the permissive default', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICY_LIST, method: 'GET', respond: collection([]) },
    { url: POLICY_CREATE, method: 'POST', respond: created({ id: 'pol-new' }) },
    ...nameMapRoutes(),
  ])
  try {
    await deploy(deployContext([policyItem({ enableTargetsToSelfAddAccess: false })]))

    const requestor = bodyOf(writeCalls(calls)[0])?.requestorSettings as Record<string, unknown>
    assert.equal(requestor.enableTargetsToSelfAddAccess, false)
  } finally {
    restore()
  }
})

test('deploy updates a policy that already exists and records its LIVE prior state', async () => {
  // The live policy is WIDE OPEN: every member user may request, nobody
  // approves. The deploy narrows it — and rollback must be able to put the wide
  // one back, so the recorded prior has to be the live values, not the canvas.
  const live = {
    id: 'pol-1',
    displayName: 'Standard',
    description: 'Old description',
    allowedTargetScope: 'allMemberUsers',
    expiration: { type: 'noExpiration' },
    specificAllowedTargets: [],
    requestorSettings: { enableTargetsToSelfAddAccess: true, onBehalfRequestors: [] },
    requestApprovalSettings: { isApprovalRequiredForAdd: false, stages: [] },
  }
  const { calls, restore } = routeFetch([
    { url: POLICY_LIST, method: 'GET', respond: collection([live]) },
    { url: POLICY_BY_ID, method: 'PATCH', respond: ok({}) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing policy is updated, not duplicated')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith('/assignmentPolicies/pol-1'))
    const sent = bodyOf(writes[0])
    assert.equal(sent?.allowedTargetScope, 'specificDirectoryUsers')
    // A PATCH never re-binds the access package — Graph rejects that, and it
    // would silently repoint the policy at a different package's audience.
    assert.equal(sent?.accessPackage, undefined)

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'pol-1')
    assert.deepEqual(entries[0].prior, {
      displayName: 'Standard',
      description: 'Old description',
      allowedTargetScope: 'allMemberUsers',
      expiration: { type: 'noExpiration' },
      specificAllowedTargets: [],
      requestorSettings: { enableTargetsToSelfAddAccess: true, onBehalfRequestors: [] },
      requestApprovalSettings: { isApprovalRequiredForAdd: false, stages: [] },
    })
    assert.notDeepEqual(entries[0].prior, sent)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an unresolvable approver name fails the item without writing a partial policy', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICY_LIST, method: 'GET', respond: collection([]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([policyItem({ primaryApproverGroups: ['Ghost Approvers'] })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown target\(s\) Ghost Approvers/)
    // Writing the policy anyway would produce an approval stage with NO
    // approvers — a request nobody can ever grant, or worse, one that skips.
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('an unresolvable access package name fails the item without writing it', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICY_LIST, method: 'GET', respond: collection([]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([policyItem({ accessPackageId: 'Ghost Package' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Ghost Package/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing, and leaks no secret', async () => {
  const { restore } = routeFetch([
    { url: POLICY_LIST, method: 'GET', respond: collection([]) },
    {
      url: POLICY_CREATE,
      method: 'POST',
      respond: graphError(400, 'A policy with this display name already exists for the access package.', 'BadRequest'),
    },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a policy it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICY_LIST, method: 'GET', respond: collection([]) },
    { url: POLICY_BY_ID, method: 'DELETE', respond: NO_CONTENT },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired policy', existed: false, id: 'pol-old' },
            { name: 'Pre-existing policy', existed: true, id: 'pol-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only the policy this app created may be deleted')
    assert.ok(deletes[0].url.endsWith('/assignmentPolicies/pol-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
