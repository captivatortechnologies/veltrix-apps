// ============================================================================
// driftDetect for the tenant admin consent request policy.
//
// The drift that matters here is someone turning the request workflow off, or
// quietly removing themselves as a reviewer, in the portal. Both are single
// fields, so most of the work is in the edges: a live object that omits a
// boolean is off (not "matches"), and the reviewer list is compared by value
// rather than by the order Graph happened to return it in.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  resource,
  TOKEN,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const REVIEWER_A = { query: '/users/reviewer-a', queryType: 'MicrosoftGraph' }
const REVIEWER_B = { query: '/groups/security-team', queryType: 'MicrosoftGraph' }

function policyItem(fields: Record<string, unknown> = {}) {
  return item('Admin Consent Requests', {
    isEnabled: true,
    notifyReviewers: true,
    remindersEnabled: true,
    requestDurationInDays: 7,
    reviewers: JSON.stringify([REVIEWER_A, REVIEWER_B]),
    ...fields,
  })
}

/** A live policy that matches the canvas above. */
function livePolicy(over: Record<string, unknown> = {}) {
  return resource({
    id: 'authorizationPolicy',
    isEnabled: true,
    notifyReviewers: true,
    remindersEnabled: true,
    requestDurationInDays: 7,
    reviewers: [REVIEWER_A, REVIEWER_B],
    ...over,
  })
}

test('makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([policyItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
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

test('reports no drift when the live policy matches what was deployed', async () => {
  const { calls, restore } = recordFetch([TOKEN, livePolicy()])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('the request workflow switched off in the portal surfaces', async () => {
  const { restore } = recordFetch([TOKEN, livePolicy({ isEnabled: false })])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.find((d) => d.field === 'isEnabled'),
      { field: 'isEnabled', expected: 'true', actual: 'false', severity: 'warning' },
    )
  } finally {
    restore()
  }
})

test('a reviewer removed in the portal surfaces with both lists', async () => {
  const { restore } = recordFetch([TOKEN, livePolicy({ reviewers: [REVIEWER_A] })])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'reviewers')
    assert.ok(diff, 'a reviewer list that no longer matches is drift')
    assert.equal(diff?.actual.includes('security-team'), false)
    assert.equal(diff?.expected.includes('security-team'), true)
  } finally {
    restore()
  }
})

test('a reviewer whose keys come back in another order is not drift', async () => {
  const { restore } = recordFetch([
    TOKEN,
    livePolicy({
      reviewers: [
        { queryType: 'MicrosoftGraph', query: '/users/reviewer-a' },
        { queryType: 'MicrosoftGraph', query: '/groups/security-team' },
      ],
    }),
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    // Graph does not promise a key order, and JSON.stringify is order-sensitive,
    // so a raw comparison would report drift on every run for a tenant that has
    // not changed at all. Positions within the list are compared as-is, which is
    // the app-wide convention: keys normalise, array order is meaningful.
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('reviewers listed in a different order ARE reported', async () => {
  const { restore } = recordFetch([TOKEN, livePolicy({ reviewers: [REVIEWER_B, REVIEWER_A] })])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    // Deploy PUTs the canvas array verbatim, so after a deploy the live order
    // is the canvas order; a different order means the list was edited in the
    // portal. Pinned so that adding array sorting later is a deliberate change
    // rather than something that quietly stops reporting a real portal edit.
    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs.filter((d) => d.field === 'reviewers').length, 1)
  } finally {
    restore()
  }
})

test('a shortened request window surfaces as a numeric diff', async () => {
  const { restore } = recordFetch([TOKEN, livePolicy({ requestDurationInDays: 30 })])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.deepEqual(
      result.diffs.find((d) => d.field === 'requestDurationInDays'),
      { field: 'requestDurationInDays', expected: '7', actual: '30', severity: 'warning' },
    )
  } finally {
    restore()
  }
})

test('a live object that omits a managed boolean reads as off, not as "matches"', async () => {
  const { restore } = recordFetch([TOKEN, resource({ id: 'authorizationPolicy', reviewers: [REVIEWER_A, REVIEWER_B] })])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    for (const field of ['isEnabled', 'notifyReviewers', 'remindersEnabled']) {
      assert.deepEqual(
        result.diffs.find((d) => d.field === field),
        { field, expected: 'true', actual: 'false', severity: 'warning' },
      )
    }
  } finally {
    restore()
  }
})

test('a failed read writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    // NOTE: the handler reports `{ hasDrift: false, diffs: [] }` here, which the
    // platform reads as a positive "checked and in sync" and uses to clear any
    // outstanding drift record. `DriftResult.checked` exists for exactly this
    // case; adopting it across the catalog is tracked separately, so this test
    // pins only the property that is unambiguously right today — an unreadable
    // target is never written to.
    assert.equal(writeCalls(calls).length, 0)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('diffs carry no token and no client secret', async () => {
  const { restore } = recordFetch([TOKEN, livePolicy({ isEnabled: false })])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    // The platform persists diffs on the drift record.
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
