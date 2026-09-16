// ============================================================================
// deploy for the tenant admin consent request policy.
//
// This is the workflow that decides whether a user who hits an app needing
// admin consent can ask for it, and who gets asked. Two things matter more than
// the happy path: the update is a full-replace PUT, so every managed field has
// to be in the body or it is silently reset; and the prior state recorded for
// rollback has to be what Graph returned, not what the canvas wanted.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCESS_TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  deployContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  resource,
  TOKEN,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy, { type RollbackEntry } from '../deploy'

const READ = /\/policies\/adminConsentRequestPolicy\?/

/** The canvas: requests on, two reviewers, a shorter window than the default. */
function policyItem(fields: Record<string, unknown> = {}) {
  return item('Admin Consent Requests', {
    isEnabled: true,
    notifyReviewers: true,
    remindersEnabled: true,
    requestDurationInDays: 7,
    reviewers: JSON.stringify([{ query: '/users/reviewer-a', queryType: 'MicrosoftGraph' }]),
    ...fields,
  })
}

/** What the tenant currently has — deliberately different from the canvas. */
function livePolicy(over: Record<string, unknown> = {}) {
  return resource({
    id: 'authorizationPolicy',
    isEnabled: false,
    notifyReviewers: false,
    remindersEnabled: false,
    requestDurationInDays: 30,
    reviewers: [{ query: '/users/old-reviewer', queryType: 'MicrosoftGraph' }],
    ...over,
  })
}

function entriesOf(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

test('refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([policyItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('refuses when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([policyItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('an empty canvas succeeds without touching the tenant', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.deepEqual(entriesOf(result), [], 'nothing was changed, so there is nothing to undo')
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('acquires a token first and reads the live policy before writing', async () => {
  const { calls, restore } = recordFetch([TOKEN, livePolicy(), resource({})])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, true)
    const graph = assertAuthenticatedFirst(assert, calls)
    assert.equal(graph.length, 2)
    assert.equal(graph[0].method, 'GET')
    assert.match(graph[0].url, READ)
    assert.equal(graph[1].method, 'PUT')
  } finally {
    restore()
  }
})

test('sends every managed field, because the update replaces the whole object', async () => {
  const { calls, restore } = recordFetch([TOKEN, livePolicy(), resource({})])
  try {
    await deploy(deployContext([policyItem()]))

    const body = bodyOf(writeCalls(calls)[0])
    // A PATCH-shaped body would leave the omitted fields at whatever the portal
    // last set; Graph resets them here, so a missing key is a silent revert.
    assert.deepEqual(Object.keys(body ?? {}).sort(), [
      'isEnabled',
      'notifyReviewers',
      'remindersEnabled',
      'requestDurationInDays',
      'reviewers',
    ])
    assert.equal(body?.isEnabled, true)
    assert.equal(body?.requestDurationInDays, 7)
    assert.deepEqual(body?.reviewers, [{ query: '/users/reviewer-a', queryType: 'MicrosoftGraph' }])
  } finally {
    restore()
  }
})

test('records the LIVE prior state, not the values being deployed', async () => {
  const { restore } = recordFetch([TOKEN, livePolicy(), resource({})])
  try {
    const result = await deploy(deployContext([policyItem()]))

    // Rollback restores what was there. Recording the canvas values here would
    // make a rollback a no-op that reports success.
    assert.deepEqual(entriesOf(result), [
      {
        existed: true,
        prior: {
          isEnabled: false,
          notifyReviewers: false,
          remindersEnabled: false,
          requestDurationInDays: 30,
          reviewers: [{ query: '/users/old-reviewer', queryType: 'MicrosoftGraph' }],
        },
      },
    ])
  } finally {
    restore()
  }
})

test('a live policy missing a field is recorded with the field, not as a hole', async () => {
  const { restore } = recordFetch([TOKEN, resource({ id: 'authorizationPolicy' }), resource({})])
  try {
    const result = await deploy(deployContext([policyItem()]))

    // Rollback PUTs this object back verbatim, and the PUT is a full replace —
    // an absent key would reset that field rather than restore it.
    assert.deepEqual(entriesOf(result)[0].prior, {
      isEnabled: false,
      notifyReviewers: false,
      remindersEnabled: false,
      requestDurationInDays: 30,
      reviewers: [],
    })
  } finally {
    restore()
  }
})

test('a failed read stops before writing anything', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /Failed to read/)
    assert.equal(writeCalls(calls).length, 0, 'without the prior state there is nothing to roll back to')
  } finally {
    restore()
  }
})

test('a rejected write is reported as a failed result, not thrown', async () => {
  const { restore } = recordFetch([TOKEN, livePolicy(), graphError(400, 'requestDurationInDays out of range')])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /requestDurationInDays out of range/)
  } finally {
    restore()
  }
})

test('neither the token nor the client secret reaches the result', async () => {
  const { restore } = recordFetch([TOKEN, livePolicy(), resource({})])
  try {
    const result = await deploy(deployContext([policyItem()]))

    assert.equal(leaksSecret(result), false)
    assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false)
  } finally {
    restore()
  }
})

test('a blank reviewers field deploys an empty list rather than failing', async () => {
  const { calls, restore } = recordFetch([TOKEN, livePolicy(), resource({})])
  try {
    const result = await deploy(deployContext([policyItem({ reviewers: '' })]))

    assert.equal(result.success, true)
    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.reviewers, [])
  } finally {
    restore()
  }
})

test('only the token and the two policy calls are made', async () => {
  const { calls, restore } = recordFetch([TOKEN, livePolicy(), resource({})])
  try {
    await deploy(deployContext([policyItem()]))

    assert.equal(vendorCalls(calls).length, 2, 'a singleton needs no listing and no lookup')
  } finally {
    restore()
  }
})
