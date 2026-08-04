import {
  buildAccessPackageScope,
  buildApplicationAccessScope,
  buildBody,
  buildDirectoryRoleScope,
  buildGroupMembershipScope,
  buildReviewerScopes,
  MANAGER_REVIEWER,
  resolveReviewers,
  resolveScope,
  type ReviewerNameMaps,
} from '../deploy'
import type { AccessReviewSpec } from '../validate'

const GROUP_ID = '11111111-1111-1111-1111-111111111111'
const ROLE_ID = '62e90394-69f5-4237-9190-012177145e10'
const PACKAGE_ID = '22222222-2222-2222-2222-222222222222'
const SP_ID = '33333333-3333-3333-3333-333333333333'
const USER_ID = '44444444-4444-4444-4444-444444444444'

describe('scope builders — reproduce Microsoft\'s cited worked examples exactly', () => {
  it('buildGroupMembershipScope — Example 1', () => {
    expect(buildGroupMembershipScope(GROUP_ID)).toEqual({
      '@odata.type': '#microsoft.graph.accessReviewQueryScope',
      query: `/groups/${GROUP_ID}/transitiveMembers`,
      queryType: 'MicrosoftGraph',
    })
  })

  it('buildDirectoryRoleScope — Example 12.2 (active user assignments)', () => {
    const scope = buildDirectoryRoleScope(ROLE_ID)
    expect(scope.query).toBe(
      `/roleManagement/directory/roleAssignmentScheduleInstances?$expand=principal&$filter=(assignmentType eq 'Assigned' and isof(principal,'microsoft.graph.user') and roleDefinitionId eq '${ROLE_ID}')`
    )
  })

  it('buildAccessPackageScope — subset of Example 10', () => {
    const scope = buildAccessPackageScope(PACKAGE_ID)
    expect(scope.query).toBe(`/identityGovernance/entitlementManagement/accessPackageAssignments?$filter=(accessPackageId eq '${PACKAGE_ID}')`)
  })

  it('buildApplicationAccessScope — Example 15 (principalResourceMembershipsScope, fixed principal pool)', () => {
    const scope = buildApplicationAccessScope(SP_ID)
    expect(scope['@odata.type']).toBe('#microsoft.graph.principalResourceMembershipsScope')
    expect(scope.resourceScopes).toEqual([
      { '@odata.type': '#microsoft.graph.accessReviewQueryScope', query: `/v1.0/servicePrincipals/${SP_ID}`, queryType: 'MicrosoftGraph', queryRoot: null },
    ])
    expect(scope.principalScopes).toHaveLength(2)
  })
})

describe('resolveScope', () => {
  const maps = {
    group: new Map([['engineering', GROUP_ID]]),
    role: new Map([['global administrator', ROLE_ID]]),
    accessPackage: new Map([['sales reps', PACKAGE_ID]]),
    servicePrincipal: new Map([['salesforce', SP_ID]]),
  }

  function specWith(overrides: Partial<AccessReviewSpec>): AccessReviewSpec {
    return {
      itemId: 'item-1',
      name: 'Test',
      descriptionForAdmins: '',
      scopeType: 'groupMembership',
      scopeGroupId: '',
      scopeRoleDefinitionId: '',
      scopeAccessPackageId: '',
      scopeServicePrincipalId: '',
      scopeCustomJson: '',
      instanceEnumerationScopeJson: '',
      reviewerUsers: [],
      reviewerGroupOwners: [],
      reviewerManagersSelfReview: false,
      reviewersCustomJson: '',
      fallbackReviewerUsers: [],
      fallbackReviewerGroupOwners: [],
      fallbackReviewersCustomJson: '',
      settings: '{}',
      ...overrides,
    }
  }

  it('resolves a hand-typed group display name for scopeType groupMembership', () => {
    const { resolved, missing } = resolveScope(specWith({ scopeType: 'groupMembership', scopeGroupId: 'Engineering' }), maps)
    expect(missing).toEqual([])
    expect(resolved?.scope.query).toBe(`/groups/${GROUP_ID}/transitiveMembers`)
  })

  it('passes a picker-stored GUID through unchanged', () => {
    const { resolved } = resolveScope(specWith({ scopeType: 'groupMembership', scopeGroupId: GROUP_ID }), maps)
    expect(resolved?.scope.query).toBe(`/groups/${GROUP_ID}/transitiveMembers`)
  })

  it('reports an unresolvable scope target as missing', () => {
    const { resolved, missing } = resolveScope(specWith({ scopeType: 'directoryRole', scopeRoleDefinitionId: 'Ghost Role' }), maps)
    expect(resolved).toBeNull()
    expect(missing).toEqual(['Ghost Role'])
  })

  it('custom scopeType parses scopeCustomJson (and optional instanceEnumerationScopeJson) as-is', () => {
    const { resolved } = resolveScope(
      specWith({
        scopeType: 'custom',
        scopeCustomJson: '{"query":"/groups/x/members","queryType":"MicrosoftGraph"}',
        instanceEnumerationScopeJson: '{"query":"/groups","queryType":"MicrosoftGraph"}',
      }),
      maps
    )
    expect(resolved?.scope).toEqual({ query: '/groups/x/members', queryType: 'MicrosoftGraph' })
    expect(resolved?.instanceEnumerationScope).toEqual({ query: '/groups', queryType: 'MicrosoftGraph' })
  })
})

describe('buildReviewerScopes', () => {
  it('appends users, group owners, the manager sentinel, then any custom JSON entries', () => {
    const scopes = buildReviewerScopes([USER_ID], [GROUP_ID], true, '[{"query":"/servicePrincipals/x/owners","queryType":"MicrosoftGraph"}]')
    expect(scopes).toEqual([
      { query: `/users/${USER_ID}`, queryType: 'MicrosoftGraph' },
      { query: `/groups/${GROUP_ID}/owners`, queryType: 'MicrosoftGraph' },
      MANAGER_REVIEWER,
      { query: '/servicePrincipals/x/owners', queryType: 'MicrosoftGraph' },
    ])
  })

  it('is empty (a valid self-review) when every field is empty', () => {
    expect(buildReviewerScopes([], [], false, '')).toEqual([])
  })
})

describe('resolveReviewers', () => {
  const maps: ReviewerNameMaps = { user: new Map([['ada', USER_ID]]), group: new Map([['engineering', GROUP_ID]]) }

  it('resolves hand-typed reviewer/fallback names and builds both arrays', () => {
    const { resolved, missing } = resolveReviewers(
      {
        reviewerUsers: ['Ada'],
        reviewerGroupOwners: [],
        reviewerManagersSelfReview: false,
        reviewersCustomJson: '',
        fallbackReviewerUsers: [],
        fallbackReviewerGroupOwners: ['Engineering'],
        fallbackReviewersCustomJson: '',
      },
      maps
    )
    expect(missing).toEqual([])
    expect(resolved.reviewers).toEqual([{ query: `/users/${USER_ID}`, queryType: 'MicrosoftGraph' }])
    expect(resolved.fallbackReviewers).toEqual([{ query: `/groups/${GROUP_ID}/owners`, queryType: 'MicrosoftGraph' }])
  })

  it('reports an unresolvable reviewer as missing instead of silently dropping them', () => {
    const { missing } = resolveReviewers(
      {
        reviewerUsers: ['Ghost User'],
        reviewerGroupOwners: [],
        reviewerManagersSelfReview: false,
        reviewersCustomJson: '',
        fallbackReviewerUsers: [],
        fallbackReviewerGroupOwners: [],
        fallbackReviewersCustomJson: '',
      },
      maps
    )
    expect(missing).toEqual(['Ghost User'])
  })
})

describe('buildBody', () => {
  it('includes instanceEnumerationScope only when the resolved scope set one', () => {
    const spec: AccessReviewSpec = {
      itemId: 'item-1',
      name: 'Test',
      descriptionForAdmins: 'desc',
      scopeType: 'groupMembership',
      scopeGroupId: GROUP_ID,
      scopeRoleDefinitionId: '',
      scopeAccessPackageId: '',
      scopeServicePrincipalId: '',
      scopeCustomJson: '',
      instanceEnumerationScopeJson: '',
      reviewerUsers: [],
      reviewerGroupOwners: [],
      reviewerManagersSelfReview: false,
      reviewersCustomJson: '',
      fallbackReviewerUsers: [],
      fallbackReviewerGroupOwners: [],
      fallbackReviewersCustomJson: '',
      settings: '{"defaultDecision":"None"}',
    }
    const body = buildBody(spec, { scope: buildGroupMembershipScope(GROUP_ID) }, { reviewers: [], fallbackReviewers: [] })
    expect(body.instanceEnumerationScope).toBeUndefined()
    expect(body.reviewers).toEqual([])
    expect(body.fallbackReviewers).toEqual([])
    expect(body.settings).toEqual({ defaultDecision: 'None' })
  })
})
