import {
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
