// ============================================================================
// deploy for the Entra authentication flows policy, against a fake Graph.
//
// This is a TENANT SINGLETON: one object, PATCH-only, never created and never
// deleted. The single field it manages, `selfServiceSignUp.isEnabled`, decides
// whether an unknown external person can create an account in the directory on
// their own. Turning it on by accident is a self-service front door, so these
// assert the exact boolean put on the wire, and that the singleton is READ for
// its prior value before it is written.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  deployContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  resource,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const PATH = '/policies/authenticationFlowsPolicy'

/** The canvas item; `selfServiceSignUpEnabled` absent means "leave it off". */
function flowsItem(fields: Record<string, unknown> = {}) {
  return item('Authentication flows', fields)
}

/** The live singleton as Graph returns it. */
function livePolicy(isEnabled: boolean) {
  return {
    id: 'authenticationFlowsPolicy',
    displayName: 'Authentication flows policy',
    selfServiceSignUp: { isEnabled },
  }
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([flowsItem({ selfServiceSignUpEnabled: true })], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('deploy refuses when the directory (tenant) id setting is missing', async () => {
  // Graph auth is per-tenant: without the directory id there is no token
  // endpoint to post to, so the handler must stop before reaching the network.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([flowsItem({ selfServiceSignUpEnabled: true })], { settings: {} }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('an empty canvas is a no-op that never touches the directory', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.match(String(result.message), /No authentication flows policy configured/)
    assert.deepEqual(result.rollbackData, { entries: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed read of the singleton stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await deploy(deployContext([flowsItem({ selfServiceSignUpEnabled: true })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to read authentication flows policy/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy authenticates, READS the singleton, then PATCHes it — in that order', async () => {
  const { calls, restore } = recordFetch([TOKEN, resource(livePolicy(false)), NO_CONTENT])
  try {
    const result = await deploy(deployContext([flowsItem({ selfServiceSignUpEnabled: true })]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 2)

    // The read has to come first, or there is no prior value to roll back to.
    assert.equal(graphCalls[0].method, 'GET')
    assert.ok(graphCalls[0].url.includes(`${PATH}?$select=id,selfServiceSignUp`))

    assert.equal(graphCalls[1].method, 'PATCH')
    assert.ok(graphCalls[1].url.endsWith(PATH), `PATCH target was ${graphCalls[1].url}`)
    assert.deepEqual(bodyOf(graphCalls[1]), { selfServiceSignUp: { isEnabled: true } })

    assert.equal(result.success, true)
    assert.match(String(result.message), /Self-service sign-up enabled/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('self-service sign-up stays OFF when the canvas does not explicitly enable it', async () => {
  // An absent field must never be read as "on" — that would open the directory
  // to self-registration on a canvas that said nothing about it.
  const { calls, restore } = recordFetch([TOKEN, resource(livePolicy(false)), NO_CONTENT])
  try {
    const result = await deploy(deployContext([flowsItem()]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), { selfServiceSignUp: { isEnabled: false } })
    assert.match(String(result.message), /Self-service sign-up disabled/)
  } finally {
    restore()
  }
})

test('deploy records the LIVE prior value, not the value it is about to send', async () => {
  // The tenant currently allows self-service sign-up; the canvas turns it off.
  // Rollback has to be able to put the tenant back the way it was.
  const { calls, restore } = recordFetch([TOKEN, resource(livePolicy(true)), NO_CONTENT])
  try {
    const result = await deploy(deployContext([flowsItem({ selfServiceSignUpEnabled: false })]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true, 'a tenant singleton always already exists')
    assert.deepEqual(entries[0].prior, { selfServiceSignUp: { isEnabled: true } })

    const sent = bodyOf(writeCalls(calls)[0])
    assert.deepEqual(sent, { selfServiceSignUp: { isEnabled: false } })
    assert.notDeepEqual(entries[0].prior, sent, 'the prior must be the live value, not the desired one')
  } finally {
    restore()
  }
})

test('a singleton with no selfServiceSignUp facet records a prior of disabled', async () => {
  const { restore } = recordFetch([TOKEN, resource({ id: 'authenticationFlowsPolicy' }), NO_CONTENT])
  try {
    const result = await deploy(deployContext([flowsItem({ selfServiceSignUpEnabled: true })]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries[0].prior, { selfServiceSignUp: { isEnabled: false } })
  } finally {
    restore()
  }
})

test('deploy reports a rejected PATCH rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    resource(livePolicy(false)),
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(deployContext([flowsItem({ selfServiceSignUpEnabled: true })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to update authentication flows policy/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a rejected token exchange stops the deploy without a single Graph call', async () => {
  const { calls, restore } = recordFetch([
    { status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' } },
  ])
  try {
    const result = await deploy(deployContext([flowsItem({ selfServiceSignUpEnabled: true })]))

    assert.equal(result.success, false)
    assert.equal(vendorCalls(calls).length, 0, 'no Graph request may be attempted without a token')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
