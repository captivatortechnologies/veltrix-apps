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

// ============================================================================
// deploy, end to end against a fake Microsoft Graph.
//
// Everything above tests the exported scope/reviewer builders in isolation.
// What follows drives the DEFAULT export — the handler that writes the access
// reviews deciding WHO attests to a group's membership and WHAT HAPPENS to
// someone the reviewers never approve.
//
// Two values carry that last part and both are asserted on the wire below:
// `settings.defaultDecision` and `settings.autoApplyDecisionsEnabled`. The
// third thing worth pinning down is that an unresolvable reviewer FAILS rather
// than collapsing to `reviewers: []`, which Graph reads as "everyone reviews
// themselves" — see resolveReviewers' own doc comment.
//
// The four scope name maps are built with `Promise.all`, so the fixture matches
// on URL (routeFetch) rather than on an order the handler does not guarantee.
// ============================================================================

const DEF_BY_ID = /accessReviews\/definitions\/[^/?]+$/
const DEF_CREATE = /accessReviews\/definitions$/
const DEF_LIST = /accessReviews\/definitions\?/
const GROUP_MAP = /\/groups\?/
const ROLE_MAP = /roleManagement\/directory\/roleDefinitions\?/
const PACKAGE_MAP = /entitlementManagement\/accessPackages\?/
const SP_MAP = /servicePrincipals\?/
const USER_MAP = /\/users\?/

const REVIEWED_GROUP = '11111111-1111-1111-1111-111111111111'
const REVIEWER_USER = '44444444-4444-4444-4444-444444444444'

/**
 * The review settings the canvas carries verbatim. `defaultDecision: "Deny"`
 * plus `autoApplyDecisionsEnabled: true` is what strips access from anyone the
 * reviewers do not act on — flip either and an un-reviewed user keeps it.
 */
const REVIEW_SETTINGS = {
  mailNotificationsEnabled: true,
  justificationRequiredOnApproval: true,
  defaultDecisionEnabled: true,
  defaultDecision: 'Deny',
  autoApplyDecisionsEnabled: true,
  instanceDurationInDays: 14,
  recurrence: {
    pattern: { type: 'absoluteMonthly', interval: 3 },
    range: { type: 'noEnd', startDate: '2026-01-01' },
  },
}

/** The exact accessReviewQueryScope the group-membership scope type produces. */
const EXPECTED_SCOPE = {
  '@odata.type': '#microsoft.graph.accessReviewQueryScope',
  query: `/groups/${REVIEWED_GROUP}/transitiveMembers`,
  queryType: 'MicrosoftGraph',
}

function reviewItem(fields: Record<string, unknown> = {}, id?: string) {
  return item(
    'Quarterly Engineering review',
    {
      name: 'Quarterly Engineering review',
      descriptionForAdmins: 'Quarterly attestation of Engineering membership',
      scopeType: 'groupMembership',
      scopeGroupId: REVIEWED_GROUP,
      reviewerUsers: [REVIEWER_USER],
      settings: JSON.stringify(REVIEW_SETTINGS),
      ...fields,
    },
    id,
  )
}

/** Routes for the five name-map listings, all empty unless a test overrides. */
function nameMapRoutes() {
  return [
    { url: ROLE_MAP, respond: collection([]) },
    { url: PACKAGE_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: USER_MAP, respond: collection([]) },
    { url: GROUP_MAP, respond: collection([]) },
  ]
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([reviewItem()], { credential: null }))

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
    const result = await deploy(deployContext([reviewItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed definition listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: DEF_LIST, method: 'GET', respond: graphError(403, 'Insufficient privileges to complete the operation.') },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([reviewItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list access reviews/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live definitions must not create or patch any',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first, then creates the review with its reviewers and deny-by-default settings', async () => {
  const { calls, restore } = routeFetch([
    { url: DEF_LIST, method: 'GET', respond: collection([]) },
    { url: DEF_CREATE, method: 'POST', respond: created({ id: 'def-new' }) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([reviewItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const write = graphCalls.find((c) => c.method === 'POST')
    assert.ok(write, 'expected a POST creating the access review definition')
    assert.ok(write.url.endsWith('/identityGovernance/accessReviews/definitions'))

    assert.deepEqual(bodyOf(write), {
      displayName: 'Quarterly Engineering review',
      descriptionForAdmins: 'Quarterly attestation of Engineering membership',
      scope: EXPECTED_SCOPE,
      // A named reviewer, NOT the empty array Graph reads as self-review.
      reviewers: [{ query: `/users/${REVIEWER_USER}`, queryType: 'MicrosoftGraph' }],
      fallbackReviewers: [],
      settings: REVIEW_SETTINGS,
    })
    // instanceEnumerationScope is omitted entirely unless the scope produced one.
    assert.equal(bodyOf(write)?.instanceEnumerationScope, undefined)

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [
      { itemId: undefined, name: 'Quarterly Engineering review', existed: false, id: 'def-new' },
    ])
    assert.equal(leaksSecret(result), false, 'the token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('an unresolvable reviewer fails the item rather than silently becoming a self-review', async () => {
  const { calls, restore } = routeFetch([
    { url: DEF_LIST, method: 'GET', respond: collection([]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([reviewItem({ reviewerUsers: ['Ghost Reviewer'] })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown reviewer target\(s\) Ghost Reviewer/)
    // Writing it anyway would send `reviewers: []` — which Graph reads as every
    // reviewed user attesting to their own access.
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a hand-typed reviewer name is resolved to its live id before the review is written', async () => {
  const { calls, restore } = routeFetch([
    { url: DEF_LIST, method: 'GET', respond: collection([]) },
    { url: DEF_CREATE, method: 'POST', respond: created({ id: 'def-new' }) },
    { url: ROLE_MAP, respond: collection([]) },
    { url: PACKAGE_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: USER_MAP, respond: collection([{ id: REVIEWER_USER, displayName: 'Ada Lovelace' }]) },
    { url: GROUP_MAP, respond: collection([{ id: REVIEWED_GROUP, displayName: 'Engineering' }]) },
  ])
  try {
    const result = await deploy(
      deployContext([reviewItem({ scopeGroupId: 'Engineering', reviewerUsers: ['Ada Lovelace'] })]),
    )

    assert.equal(result.success, true)
    const body = bodyOf(writeCalls(calls)[0])
    assert.deepEqual(body?.reviewers, [{ query: `/users/${REVIEWER_USER}`, queryType: 'MicrosoftGraph' }])
    assert.deepEqual(body?.scope, EXPECTED_SCOPE)
  } finally {
    restore()
  }
})

test('an unresolvable scope target fails the item without writing a review of the wrong thing', async () => {
  const { calls, restore } = routeFetch([
    { url: DEF_LIST, method: 'GET', respond: collection([]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([reviewItem({ scopeGroupId: 'Ghost Group' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown scope target\(s\) Ghost Group/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a custom scope sends both the scope and its instance enumeration scope', async () => {
  const { calls, restore } = routeFetch([
    { url: DEF_LIST, method: 'GET', respond: collection([]) },
    { url: DEF_CREATE, method: 'POST', respond: created({ id: 'def-new' }) },
    ...nameMapRoutes(),
  ])
  try {
    await deploy(
      deployContext([
        reviewItem({
          scopeType: 'custom',
          scopeCustomJson: '{"query":"/groups/x/members","queryType":"MicrosoftGraph"}',
          instanceEnumerationScopeJson: '{"query":"/groups","queryType":"MicrosoftGraph"}',
        }),
      ]),
    )

    const body = bodyOf(writeCalls(calls)[0])
    assert.deepEqual(body?.scope, { query: '/groups/x/members', queryType: 'MicrosoftGraph' })
    assert.deepEqual(body?.instanceEnumerationScope, { query: '/groups', queryType: 'MicrosoftGraph' })
  } finally {
    restore()
  }
})

test('deploy updates a review that already exists and records its LIVE prior state', async () => {
  // The live review is the permissive one: nobody named reviews it, and
  // anything un-actioned is approved. Rollback has to be able to put THAT back.
  const live = {
    id: 'def-1',
    displayName: 'Quarterly Engineering review',
    descriptionForAdmins: 'Old description',
    scope: {
      '@odata.type': '#microsoft.graph.accessReviewQueryScope',
      query: '/groups/old-group-id/transitiveMembers',
      queryType: 'MicrosoftGraph',
    },
    reviewers: [],
    fallbackReviewers: [],
    settings: { defaultDecision: 'Approve', autoApplyDecisionsEnabled: false },
  }
  const { calls, restore } = routeFetch([
    { url: DEF_LIST, method: 'GET', respond: collection([live]) },
    { url: DEF_BY_ID, method: 'PATCH', respond: ok({}) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([reviewItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing definition is updated, not duplicated')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith('/accessReviews/definitions/def-1'))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'def-1')
    assert.deepEqual(entries[0].prior, {
      displayName: 'Quarterly Engineering review',
      descriptionForAdmins: 'Old description',
      scope: live.scope,
      instanceEnumerationScope: null,
      reviewers: [],
      fallbackReviewers: [],
      settings: { defaultDecision: 'Approve', autoApplyDecisionsEnabled: false },
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(writes[0]))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing, and leaks no secret', async () => {
  const { restore } = routeFetch([
    { url: DEF_LIST, method: 'GET', respond: collection([]) },
    {
      url: DEF_CREATE,
      method: 'POST',
      respond: graphError(400, 'The recurrence range start date must be in the future.', 'BadRequest'),
    },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(deployContext([reviewItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /must be in the future/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a review it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: DEF_LIST, method: 'GET', respond: collection([]) },
    { url: DEF_BY_ID, method: 'DELETE', respond: NO_CONTENT },
    ...nameMapRoutes(),
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired review', existed: false, id: 'def-old' },
            { name: 'Pre-existing review', existed: true, id: 'def-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only the review this app created may be deleted')
    assert.ok(deletes[0].url.endsWith('/accessReviews/definitions/def-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
