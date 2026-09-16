// ============================================================================
// deploy for Conditional Access authentication contexts, against a fake Graph.
//
// An authentication context (c1..c25) is the handle a Conditional Access policy
// and a protected application agree on: the app asks for `acrs: c3`, the policy
// that guards c3 demands the step-up. Two things therefore matter on the wire —
// the context id the PATCH is addressed to, and `isAvailable`, because a context
// that is not available cannot be selected and the step-up silently stops being
// requestable.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  deployContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const BASE = '/identity/conditionalAccess/authenticationContextClassReferences'

function contextItem(fields: Record<string, unknown> = {}) {
  return item('High risk step-up', { contextId: 'c3', displayName: 'High risk step-up', ...fields })
}

/** A live context as Graph lists it. */
function liveContext(over: Record<string, unknown> = {}) {
  return {
    id: 'c3',
    displayName: 'High risk step-up',
    description: 'Requires phishing-resistant MFA',
    isAvailable: true,
    ...over,
  }
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([contextItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('deploy refuses when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([contextItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing stops the deploy before it writes anything', async () => {
  // Without the listing the handler cannot tell an existing context from a new
  // one, so it has no prior state to record — it must not write regardless.
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await deploy(deployContext([contextItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list authentication contexts/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates a context that does not exist yet', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([contextItem({ description: 'Requires phishing-resistant MFA', isAvailable: true })]),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 2)
    assert.equal(graphCalls[0].method, 'GET', 'the live listing has to be read before anything is written')

    // Create and update are the same PATCH upsert, keyed by the context id.
    assert.equal(graphCalls[1].method, 'PATCH')
    assert.ok(graphCalls[1].url.endsWith(`${BASE}/c3`), `PATCH target was ${graphCalls[1].url}`)
    assert.deepEqual(bodyOf(graphCalls[1]), {
      displayName: 'High risk step-up',
      description: 'Requires phishing-resistant MFA',
      isAvailable: true,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false, 'nothing was there before, so rollback must delete it')
    assert.equal(entries[0].prior, undefined, 'there is no prior state to invent for a context that did not exist')
    assert.equal(entries[0].id, 'c3')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy updates an existing context and records its LIVE prior fields', async () => {
  const live = liveContext()
  const { calls, restore } = recordFetch([TOKEN, collection([live]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([contextItem({ displayName: 'Renamed step-up', description: '', isAvailable: false })]),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`${BASE}/c3`))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true, 'it pre-existed, so rollback must restore rather than delete')
    // The values the tenant HAD, so rollback can put the context back in play.
    assert.deepEqual(entries[0].prior, {
      displayName: 'High risk step-up',
      description: 'Requires phishing-resistant MFA',
      isAvailable: true,
    })

    const sent = bodyOf(writes[0])
    assert.deepEqual(sent, { displayName: 'Renamed step-up', description: '', isAvailable: false })
    assert.notDeepEqual(entries[0].prior, sent, 'the prior must be the live state, not the desired one')
  } finally {
    restore()
  }
})

test('isAvailable is sent false unless the canvas explicitly makes the context available', async () => {
  // A context left unavailable cannot be picked by a Conditional Access policy
  // or requested by an app, so this flag must never be set by inference.
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    await deploy(deployContext([contextItem()]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.equal(body?.isAvailable, false)
    assert.equal(body?.description, '', 'an absent description is sent as empty, not omitted')
  } finally {
    restore()
  }
})

test('a context id typed in upper case is normalised to the reserved lower-case id', async () => {
  // Graph's reserved ids are c1..c25; "C3" and "c3" must not become two contexts.
  const { calls, restore } = recordFetch([TOKEN, collection([liveContext()]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([contextItem({ contextId: 'C3' })]))

    assert.ok(writeCalls(calls)[0].url.endsWith(`${BASE}/c3`))
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true, 'the upper-case id must still match the live c3')
  } finally {
    restore()
  }
})

test('an item with no context id is skipped — nothing is written for it', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await deploy(deployContext([item('No id', { displayName: 'No id' })]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(result.rollbackData, { entries: [] })
  } finally {
    restore()
  }
})

test('deploy reports a rejected PATCH rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    graphError(400, 'Authentication context id must be one of c1..c25.', 'Request_BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([contextItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some authentication contexts failed/)
    assert.match(String(result.message), /c3: .*must be one of c1\.\.c25/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a failure on one context still records rollback state for the one that landed', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    NO_CONTENT,
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(
      deployContext([contextItem(), contextItem({ contextId: 'c4', displayName: 'Finance step-up' })]),
    )

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, 'c3')
  } finally {
    restore()
  }
})

test('reconcile deletes a context this app created and no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [{ name: 'c9', existed: false, id: 'c9' }],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.ok(deletes[0].url.endsWith(`${BASE}/c9`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reconcile leaves a context that pre-existed this app alone', async () => {
  // `existed: true` means the tenant had it before the first deploy — deleting
  // it would take down whatever Conditional Access policy references it.
  const { calls, restore } = recordFetch([TOKEN, collection([liveContext({ id: 'c8' })])])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [{ name: 'c8', existed: true, id: 'c8', prior: { displayName: 'Legacy', description: '', isAvailable: true } }],
        },
      }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a context still declared is never swept up by reconcile', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveContext()]), NO_CONTENT])
  try {
    await deploy(
      deployContext([contextItem()], {
        priorRollbackData: { entries: [{ name: 'c3', existed: false, id: 'c3' }] },
      }),
    )

    assert.equal(
      writeCalls(calls).filter((c) => c.method === 'DELETE').length,
      0,
    )
  } finally {
    restore()
  }
})

test('a rejected token exchange stops the deploy without a single Graph call', async () => {
  const { calls, restore } = recordFetch([
    { status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' } },
  ])
  try {
    const result = await deploy(deployContext([contextItem()]))

    assert.equal(result.success, false)
    assert.equal(vendorCalls(calls).length, 0, 'no Graph request may be attempted without a token')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
