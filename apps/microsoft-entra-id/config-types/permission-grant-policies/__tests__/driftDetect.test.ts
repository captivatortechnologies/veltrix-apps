// ============================================================================
// driftDetect for custom permission grant policies.
//
// A permission grant policy is the rule that decides which app permissions
// users may consent to on their own. Widening one in the portal — adding a
// condition set that permits all delegated scopes, or deleting an exclusion —
// is the drift that matters, and it lives in the `includes` / `excludes`
// collections rather than on the policy object, so each one is a separate read.
//
// Two things the comparison has to get right: Graph decorates every returned
// condition set with an `id` and `@odata` keys the canvas never declares, and
// it does not promise an order — so a raw comparison would report drift on
// every run for a tenant nobody has touched.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  notFound,
  recordFetch,
  resource,
  routeFetch,
  TOKEN,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const POLICY_ID = 'contoso-low-risk-consent'

/** A condition set as the canvas declares it. */
const INCLUDE_LOW_RISK = {
  permissionType: 'delegated',
  permissionClassification: 'low',
  clientApplicationsFromVerifiedPublisherOnly: true,
}
const EXCLUDE_MAIL_READ = {
  permissionType: 'delegated',
  permissions: ['570282fd-fa5c-430d-a7fd-fc8dc98a9dca'],
}

/** The same set as Graph returns it: decorated with an id and an @odata type. */
function asLive(set: Record<string, unknown>, id: string) {
  return { id, '@odata.type': '#microsoft.graph.permissionGrantConditionSet', ...set }
}

function policyItem(fields: Record<string, unknown> = {}) {
  return item('Low-risk consent', {
    id: POLICY_ID,
    displayName: 'Low-risk consent',
    description: 'Delegated low-risk permissions from verified publishers',
    includes: JSON.stringify([INCLUDE_LOW_RISK]),
    excludes: JSON.stringify([EXCLUDE_MAIL_READ]),
    ...fields,
  })
}

/** True when one of the canonicalised condition sets permits every classification. */
function mentionsAllClassification(canonical: string): boolean {
  const sets = JSON.parse(canonical) as string[]
  return sets.some((s) => (JSON.parse(s) as Record<string, unknown>).permissionClassification === 'all')
}

const POLICY_READ = new RegExp(`/policies/permissionGrantPolicies/${POLICY_ID}\\?`)
const INCLUDES = new RegExp(`/policies/permissionGrantPolicies/${POLICY_ID}/includes`)
const EXCLUDES = new RegExp(`/policies/permissionGrantPolicies/${POLICY_ID}/excludes`)

/** A live tenant matching the canvas above. */
function inSyncRoutes(over: { policy?: unknown; includes?: unknown; excludes?: unknown } = {}) {
  return [
    {
      url: POLICY_READ,
      respond:
        (over.policy as never) ??
        resource({
          id: POLICY_ID,
          displayName: 'Low-risk consent',
          description: 'Delegated low-risk permissions from verified publishers',
        }),
    },
    { url: INCLUDES, respond: (over.includes as never) ?? collection([asLive(INCLUDE_LOW_RISK, 'inc-1')]) },
    { url: EXCLUDES, respond: (over.excludes as never) ?? collection([asLive(EXCLUDE_MAIL_READ, 'exc-1')]) },
  ]
}

test('makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([policyItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('nothing deployed means nothing to compare — and no Graph call', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([], { deployedItems: [] }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a built-in Microsoft policy is never compared', async () => {
  const { calls, restore } = recordFetch([])
  try {
    // The app refuses to manage the `microsoft-` policies, so drift against one
    // would report on something no deploy here could ever have written.
    const result = await driftDetect(
      driftContext([policyItem({ id: 'microsoft-user-default-legacy' })]),
    )

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('reports no drift when the live policy and both collections match', async () => {
  const { calls, restore } = routeFetch(inSyncRoutes())
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('a policy deleted in the portal is critical drift', async () => {
  const { restore } = routeFetch([{ url: POLICY_READ, respond: notFound() }])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: POLICY_ID, expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a deleted policy is not chased for its condition sets', async () => {
  const { calls, restore } = routeFetch([{ url: POLICY_READ, respond: notFound() }])
  try {
    await driftDetect(driftContext([policyItem()]))

    assert.equal(
      vendorCalls(calls).filter((c) => /\/(includes|excludes)/.test(c.url)).length,
      0,
      'the collections of a policy that is gone are two guaranteed 404s',
    )
  } finally {
    restore()
  }
})

test('a renamed policy surfaces with the id in the field name', async () => {
  const { restore } = routeFetch(
    inSyncRoutes({ policy: resource({ id: POLICY_ID, displayName: 'Anything goes', description: '' }) }),
  )
  try {
    const result = await driftDetect(driftContext([policyItem({ description: '' })]))

    assert.deepEqual(result.diffs, [
      {
        field: `${POLICY_ID}.displayName`,
        expected: 'Low-risk consent',
        actual: 'Anything goes',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a description Graph returns as null reads as empty, not as drift', async () => {
  const { restore } = routeFetch(
    inSyncRoutes({ policy: resource({ id: POLICY_ID, displayName: 'Low-risk consent', description: null }) }),
  )
  try {
    const result = await driftDetect(driftContext([policyItem({ description: '' })]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('a condition set added to includes in the portal surfaces', async () => {
  const { restore } = routeFetch(
    inSyncRoutes({
      includes: collection([
        asLive(INCLUDE_LOW_RISK, 'inc-1'),
        asLive({ permissionType: 'delegated', permissionClassification: 'all' }, 'inc-2'),
      ]),
    }),
  )
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === `${POLICY_ID}.includes`)
    assert.ok(diff, 'a widened consent rule is exactly what this detector is for')
    // expected/actual are a JSON array of canonicalised condition sets, so the
    // added rule is one more entry rather than a changed one.
    assert.equal(mentionsAllClassification(diff.actual), true)
    assert.equal(mentionsAllClassification(diff.expected), false)
  } finally {
    restore()
  }
})

test('an exclusion removed in the portal surfaces', async () => {
  const { restore } = routeFetch(inSyncRoutes({ excludes: collection([]) }))
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      [`${POLICY_ID}.excludes`],
    )
  } finally {
    restore()
  }
})

test('the id and @odata keys Graph adds are not drift', async () => {
  const { restore } = routeFetch(inSyncRoutes())
  try {
    // Every live condition set carries an id the canvas cannot know and an
    // @odata.type it never writes. Comparing them raw would report permanent
    // drift that no deploy could ever converge.
    const result = await driftDetect(driftContext([policyItem()]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('condition sets returned in another order are not drift', async () => {
  const second = { permissionType: 'application', permissionClassification: 'low' }
  const { restore } = routeFetch(
    inSyncRoutes({
      includes: collection([asLive(second, 'inc-2'), asLive(INCLUDE_LOW_RISK, 'inc-1')]),
    }),
  )
  try {
    const result = await driftDetect(
      driftContext([policyItem({ includes: JSON.stringify([INCLUDE_LOW_RISK, second]) })]),
    )

    // Graph does not promise an order for a collection, so the comparison is
    // set-wise; otherwise a tenant nobody touched drifts on every scheduled run.
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('a failed collection read writes nothing', async () => {
  const { calls, restore } = routeFetch(
    inSyncRoutes({ includes: graphError(500, 'Service unavailable') }),
  )
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    // Two things at once: a transient 500 is not announced as "every condition
    // set was removed", AND the run admits it did not see everything, so the
    // platform does not treat this as a verified clean estate.
    assert.equal(result.checked, false)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(
      result.diffs.some((d) => d.field === `${POLICY_ID}.includes`),
      false,
      'an unreadable collection must not be reported as an emptied one',
    )
  } finally {
    restore()
  }
})

test('a failed policy read reports nothing rather than a false absence', async () => {
  const { restore } = routeFetch([{ url: POLICY_READ, respond: graphError(403, 'Insufficient privileges.') }])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    // 403 is "I could not look", not "the policy is gone" — reporting it as
    // absent would send an operator to recreate a policy that already exists.
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('several policies are each compared, and one failure does not hide the others', async () => {
  const OTHER = 'contoso-legacy-consent'
  const { restore } = routeFetch([
    { url: POLICY_READ, respond: notFound() },
    {
      url: new RegExp(`/policies/permissionGrantPolicies/${OTHER}\\?`),
      respond: resource({ id: OTHER, displayName: 'Renamed in portal', description: '' }),
    },
    { url: new RegExp(`/policies/permissionGrantPolicies/${OTHER}/`), respond: collection([]) },
  ])
  try {
    const result = await driftDetect(
      driftContext([
        policyItem(),
        policyItem({ id: OTHER, displayName: 'Legacy consent', description: '', includes: '', excludes: '' }),
      ]),
    )

    assert.deepEqual(
      result.diffs.map((d) => d.field),
      [POLICY_ID, `${OTHER}.displayName`],
    )
  } finally {
    restore()
  }
})

test('diffs carry no token and no client secret', async () => {
  const { restore } = routeFetch(inSyncRoutes({ excludes: collection([]) }))
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
