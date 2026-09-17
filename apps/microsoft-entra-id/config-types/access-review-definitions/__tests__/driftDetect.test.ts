// ============================================================================
// driftDetect for Entra access review schedule definitions, against a fake
// Microsoft Graph.
//
// Three of the diffs this handler can raise are governance failures rather than
// cosmetic drift: reviewers emptied out (so reviewed users attest to their own
// access), `settings.defaultDecision` flipped to Approve (so nobody loses
// access by inaction), and a scope repointed at a different population.
//
// The handler also has two CRITICAL "cannot even resolve this" branches — an
// unknown scope target and an unknown reviewer — which exist so an unresolvable
// name never looks like "no drift". Both are asserted below.
//
// The five name maps are built with `Promise.all`, so the fixture matches on
// URL (routeFetch) rather than on an order the handler does not guarantee.
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

const DEF_LIST = /accessReviews\/definitions\?/
const GROUP_MAP = /\/groups\?/
const ROLE_MAP = /roleManagement\/directory\/roleDefinitions\?/
const PACKAGE_MAP = /entitlementManagement\/accessPackages\?/
const SP_MAP = /servicePrincipals\?/
const USER_MAP = /\/users\?/

const REVIEWED_GROUP = '11111111-1111-1111-1111-111111111111'
const REVIEWER_USER = '44444444-4444-4444-4444-444444444444'

const REVIEW_SETTINGS = {
  defaultDecisionEnabled: true,
  defaultDecision: 'Deny',
  autoApplyDecisionsEnabled: true,
  instanceDurationInDays: 14,
}

const DEPLOYED_SCOPE = {
  '@odata.type': '#microsoft.graph.accessReviewQueryScope',
  query: `/groups/${REVIEWED_GROUP}/transitiveMembers`,
  queryType: 'MicrosoftGraph',
}

const DEPLOYED_REVIEWERS = [{ query: `/users/${REVIEWER_USER}`, queryType: 'MicrosoftGraph' }]

function liveReview(over: Record<string, unknown> = {}) {
  return {
    id: 'def-1',
    displayName: 'Quarterly Engineering review',
    descriptionForAdmins: 'Quarterly attestation of Engineering membership',
    scope: DEPLOYED_SCOPE,
    reviewers: DEPLOYED_REVIEWERS,
    fallbackReviewers: [],
    settings: REVIEW_SETTINGS,
    ...over,
  }
}

function reviewItem(fields: Record<string, unknown> = {}) {
  return item('Quarterly Engineering review', {
    name: 'Quarterly Engineering review',
    descriptionForAdmins: 'Quarterly attestation of Engineering membership',
    scopeType: 'groupMembership',
    scopeGroupId: REVIEWED_GROUP,
    reviewerUsers: [REVIEWER_USER],
    settings: JSON.stringify(REVIEW_SETTINGS),
    ...fields,
  })
}

function nameMapRoutes() {
  return [
    { url: ROLE_MAP, respond: collection([]) },
    { url: PACKAGE_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: USER_MAP, respond: collection([]) },
    { url: GROUP_MAP, respond: collection([]) },
  ]
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([reviewItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([reviewItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: DEF_LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([reviewItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live definition matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: DEF_LIST, respond: collection([liveReview()]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([reviewItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted definition is critical present/absent drift', async () => {
  const { restore } = routeFetch([{ url: DEF_LIST, respond: collection([]) }, ...nameMapRoutes()])
  try {
    const result = await driftDetect(driftContext([reviewItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: 'Quarterly Engineering review',
        expected: 'present',
        actual: 'absent',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})

test('reviewers emptied in the portal — a silent self-review — surfaces as a diff', async () => {
  const { restore } = routeFetch([
    { url: DEF_LIST, respond: collection([liveReview({ reviewers: [] })]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([reviewItem()]))

    assert.equal(result.diffs.length, 1)
    const diff = result.diffs[0]
    assert.equal(diff.field, 'Quarterly Engineering review.reviewers')
    assert.equal(diff.severity, 'warning')
    assert.deepEqual(JSON.parse(String(diff.expected)), DEPLOYED_REVIEWERS)
    assert.deepEqual(JSON.parse(String(diff.actual)), [])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a defaultDecision flipped to Approve surfaces as settings drift', async () => {
  const drifted = { ...REVIEW_SETTINGS, defaultDecision: 'Approve', autoApplyDecisionsEnabled: false }
  const { restore } = routeFetch([
    { url: DEF_LIST, respond: collection([liveReview({ settings: drifted })]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([reviewItem()]))

    assert.equal(result.diffs.length, 1)
    const diff = result.diffs[0]
    assert.equal(diff.field, 'Quarterly Engineering review.settings')
    assert.equal(diff.severity, 'warning')
    assert.deepEqual(JSON.parse(String(diff.expected)), REVIEW_SETTINGS)
    assert.deepEqual(JSON.parse(String(diff.actual)), drifted)
  } finally {
    restore()
  }
})

test('a scope repointed at a different population surfaces as scope drift', async () => {
  const drifted = { ...DEPLOYED_SCOPE, query: '/groups/some-other-group/transitiveMembers' }
  const { restore } = routeFetch([
    { url: DEF_LIST, respond: collection([liveReview({ scope: drifted })]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([reviewItem()]))

    const diff = result.diffs.find((d) => d.field === 'Quarterly Engineering review.scope')
    assert.ok(diff)
    assert.equal(diff.severity, 'warning')
    assert.deepEqual(JSON.parse(String(diff.expected)), DEPLOYED_SCOPE)
    assert.deepEqual(JSON.parse(String(diff.actual)), drifted)
  } finally {
    restore()
  }
})

test('a description edited in the portal surfaces as its own diff', async () => {
  const { restore } = routeFetch([
    { url: DEF_LIST, respond: collection([liveReview({ descriptionForAdmins: 'Edited in the portal' })]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([reviewItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Quarterly Engineering review.descriptionForAdmins',
        expected: 'Quarterly attestation of Engineering membership',
        actual: 'Edited in the portal',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a scope target that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: DEF_LIST, respond: collection([liveReview()]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([reviewItem({ scopeGroupId: 'Ghost Group' })]))

    const diff = result.diffs.find((d) => d.field === 'Quarterly Engineering review.scope')
    assert.ok(diff)
    assert.equal(diff.expected, 'resolvable')
    assert.equal(diff.severity, 'critical')
    assert.match(String(diff.actual), /Ghost Group/)
  } finally {
    restore()
  }
})

test('a reviewer that no longer resolves is critical drift, not an unnoticed self-review', async () => {
  const { restore } = routeFetch([
    { url: DEF_LIST, respond: collection([liveReview()]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(driftContext([reviewItem({ reviewerUsers: ['Ghost Reviewer'] })]))

    const diff = result.diffs.find((d) => d.field === 'Quarterly Engineering review.reviewers')
    assert.ok(diff)
    assert.equal(diff.expected, 'resolvable')
    assert.equal(diff.severity, 'critical')
    assert.match(String(diff.actual), /Ghost Reviewer/)
  } finally {
    restore()
  }
})

test('drift is measured against the DEPLOYED canvas, not the edited one', async () => {
  // The canvas has since been edited to auto-approve, but nothing has deployed
  // that — the live definition still matches what was last deployed.
  const { restore } = routeFetch([
    { url: DEF_LIST, respond: collection([liveReview()]) },
    ...nameMapRoutes(),
  ])
  try {
    const result = await driftDetect(
      driftContext(
        [reviewItem({ settings: JSON.stringify({ ...REVIEW_SETTINGS, defaultDecision: 'Approve' }) })],
        { deployedItems: [reviewItem()] },
      ),
    )

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})
