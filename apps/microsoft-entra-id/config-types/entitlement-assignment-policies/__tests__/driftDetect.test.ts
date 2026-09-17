// ============================================================================
// driftDetect for Entra access-package assignment policies, against a fake
// Microsoft Graph.
//
// Every drift this handler can report is an access drift: the audience widened,
// the self-service flags loosened, or the approval chain removed. Three of the
// four diffs carry canonicalised JSON, so the assertions below parse both sides
// back and compare structures rather than a key ordering.
//
// The four display-name -> id maps are built with `Promise.all`, so the fixture
// matches on URL (routeFetch) rather than encoding an order the handler does
// not actually guarantee.
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
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const POLICY_LIST = /assignmentPolicies\?/
const USER_MAP = /\/users\?/
const GROUP_MAP = /\/groups\?/
const SP_MAP = /servicePrincipals\?/
const CONNORG_MAP = /connectedOrganizations\?/

const PACKAGE_GUID = '55555555-5555-5555-5555-555555555555'
const REQUESTOR_GUID = '11111111-1111-1111-1111-111111111111'
const APPROVER_GROUP_GUID = '22222222-2222-2222-2222-222222222222'

const REQUESTOR_SUBJECT = { '@odata.type': '#microsoft.graph.singleUser', userId: REQUESTOR_GUID }
const APPROVER_SUBJECT = { '@odata.type': '#microsoft.graph.groupMembers', groupId: APPROVER_GROUP_GUID }

/** Exactly what the canvas item below resolves to — the live policy must match. */
const DEPLOYED_REQUESTOR_SETTINGS = {
  enableTargetsToSelfAddAccess: true,
  enableTargetsToSelfUpdateAccess: false,
  enableTargetsToSelfRemoveAccess: false,
  allowCustomAssignmentSchedule: true,
  enableOnBehalfRequestorsToAddAccess: false,
  enableOnBehalfRequestorsToUpdateAccess: false,
  enableOnBehalfRequestorsToRemoveAccess: false,
  onBehalfRequestors: [],
}

const DEPLOYED_APPROVAL_SETTINGS = {
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

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'pol-1',
    displayName: 'Standard',
    description: 'Standard request policy',
    allowedTargetScope: 'specificDirectoryUsers',
    expiration: {},
    specificAllowedTargets: [REQUESTOR_SUBJECT],
    requestorSettings: DEPLOYED_REQUESTOR_SETTINGS,
    requestApprovalSettings: DEPLOYED_APPROVAL_SETTINGS,
    ...over,
  }
}

function policyItem(fields: Record<string, unknown> = {}) {
  return item('Standard', {
    name: 'Standard',
    accessPackageId: PACKAGE_GUID,
    description: 'Standard request policy',
    allowedTargetScope: 'specificDirectoryUsers',
    specificTargetUsers: [REQUESTOR_GUID],
    isApprovalRequiredForAdd: true,
    primaryApproverGroups: [APPROVER_GROUP_GUID],
    ...fields,
  })
}

function nameMapRoutes() {
  return [
    { url: USER_MAP, respond: collection([]) },
    { url: GROUP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: CONNORG_MAP, respond: collection([]) },
  ]
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([policyItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([policyItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICY_LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live policy matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICY_LIST, respond: collection([livePolicy()]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted policy is critical present/absent drift', async () => {
  const { restore } = routeFetch([{ url: POLICY_LIST, respond: collection([]) }, ...nameMapRoutes()])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs[0], {
      field: 'Standard',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
  } finally {
    restore()
  }
})

test('an audience widened to every member user in the portal surfaces exactly', async () => {
  const { restore } = routeFetch([
    {
      url: POLICY_LIST,
      respond: collection([livePolicy({ allowedTargetScope: 'allMemberUsers', specificAllowedTargets: [] })]),
    },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    const scope = result.diffs.find((d) => d.field === 'Standard.allowedTargetScope')
    assert.ok(scope)
    assert.deepEqual(scope, {
      field: 'Standard.allowedTargetScope',
      expected: 'specificDirectoryUsers',
      actual: 'allMemberUsers',
      severity: 'warning',
    })

    // The named requestor was dropped from specificAllowedTargets at the same
    // time — that is a second, separately reported drift.
    const targets = result.diffs.find((d) => d.field === 'Standard.specificAllowedTargets')
    assert.ok(targets)
    assert.equal(targets.severity, 'warning')
    assert.deepEqual(JSON.parse(String(targets.expected)), [REQUESTOR_SUBJECT])
    assert.deepEqual(JSON.parse(String(targets.actual)), [])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('an approval chain removed in the portal surfaces with both sides intact', async () => {
  const { restore } = routeFetch([
    {
      url: POLICY_LIST,
      respond: collection([
        livePolicy({
          requestApprovalSettings: {
            isApprovalRequiredForAdd: false,
            isApprovalRequiredForUpdate: false,
            isRequestorJustificationRequired: true,
            stages: [],
          },
        }),
      ]),
    },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.diffs.length, 1)
    const diff = result.diffs[0]
    assert.equal(diff.field, 'Standard.requestApprovalSettings')
    assert.equal(diff.severity, 'warning')
    assert.deepEqual(JSON.parse(String(diff.expected)), DEPLOYED_APPROVAL_SETTINGS)
    assert.deepEqual(JSON.parse(String(diff.actual)), {
      isApprovalRequiredForAdd: false,
      isApprovalRequiredForUpdate: false,
      isRequestorJustificationRequired: true,
      stages: [],
    })
  } finally {
    restore()
  }
})

test('self-service removal switched on in the portal surfaces as requestorSettings drift', async () => {
  const drifted = { ...DEPLOYED_REQUESTOR_SETTINGS, enableTargetsToSelfRemoveAccess: true }
  const { restore } = routeFetch([
    { url: POLICY_LIST, respond: collection([livePolicy({ requestorSettings: drifted })]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.diffs.length, 1)
    const diff = result.diffs[0]
    assert.equal(diff.field, 'Standard.requestorSettings')
    assert.equal(diff.severity, 'warning')
    assert.deepEqual(JSON.parse(String(diff.expected)), DEPLOYED_REQUESTOR_SETTINGS)
    assert.deepEqual(JSON.parse(String(diff.actual)), drifted)
  } finally {
    restore()
  }
})

test('a hand-typed approver name is resolved against the live directory before diffing', async () => {
  // Without the live group map, "Access Approvers" would resolve to nothing and
  // the handler would report a false drift against an identical live policy.
  const { restore } = routeFetch([
    { url: POLICY_LIST, respond: collection([livePolicy()]) },
    { url: USER_MAP, respond: collection([{ id: REQUESTOR_GUID, displayName: 'Ada Lovelace' }]) },
    { url: GROUP_MAP, respond: collection([{ id: APPROVER_GROUP_GUID, displayName: 'Access Approvers' }]) },
    { url: SP_MAP, respond: collection([]) },
    { url: CONNORG_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(
      driftContext([
        policyItem({ specificTargetUsers: ['Ada Lovelace'], primaryApproverGroups: ['Access Approvers'] }),
      ]),
    )

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('drift is measured against the DEPLOYED canvas, not the edited one', async () => {
  // The canvas has since been widened to allMemberUsers, but nothing has
  // deployed that — the live policy still matches what was last deployed.
  const { restore } = routeFetch([
    { url: POLICY_LIST, respond: collection([livePolicy()]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(
      driftContext([policyItem({ allowedTargetScope: 'allMemberUsers' })], {
        deployedItems: [policyItem()],
      }),
    )

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})
