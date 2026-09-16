// ============================================================================
// deploy for the Entra security-defaults enforcement policy, against a fake
// Microsoft Graph.
//
// This config type is a tenant SINGLETON with exactly one field, and that field
// is a blast radius: security defaults is mutually exclusive with Conditional
// Access, so flipping it on tears down every CA policy the tenant relies on,
// and flipping it off strips baseline MFA from a tenant that has no CA at all.
// The assertions below are therefore about the one boolean actually put on the
// wire, and about the LIVE prior value being what rollback gets to restore.
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

const PATH = '/policies/identitySecurityDefaultsEnforcementPolicy'

/** The canvas item — one boolean, defaulting to "disabled" like the canvas does. */
function defaultsItem(isEnabled: unknown = false) {
  return item('Security Defaults', { isEnabled })
}

/** The live singleton as Graph returns it. */
function live(isEnabled: boolean) {
  return resource({ id: '00000000-0000-0000-0000-000000000005', isEnabled })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([defaultsItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call, not half way through.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([defaultsItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('an empty canvas leaves the tenant alone entirely', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means nothing read and nothing written')
    assert.deepEqual(result.rollbackData, { entries: [] })
  } finally {
    restore()
  }
})

test('a failed read of the live policy stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(deployContext([defaultsItem(true)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to read security defaults/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot read the prior value must not overwrite it — rollback would have nothing to restore',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and sends exactly the declared state, never enabling by accident', async () => {
  const { calls, restore } = recordFetch([TOKEN, live(false), NO_CONTENT])
  try {
    const result = await deploy(deployContext([defaultsItem(false)]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls[0].method, 'GET', 'the live value is read before it is overwritten')
    assert.ok(graphCalls[0].url.includes(PATH))

    const patch = writeCalls(calls)
    assert.equal(patch.length, 1)
    assert.equal(patch[0].method, 'PATCH')
    assert.ok(patch[0].url.endsWith(PATH), `expected a PATCH to the singleton, got ${patch[0].url}`)
    // Enabling security defaults disables every Conditional Access policy in
    // the tenant. It happens only when the canvas literally says so.
    assert.deepEqual(bodyOf(patch[0]), { isEnabled: false })
    assert.equal(result.success, true)
    assert.match(String(result.message), /disabled/)
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('deploy sends isEnabled true only when the canvas explicitly asks for it', async () => {
  const { calls, restore } = recordFetch([TOKEN, live(false), NO_CONTENT])
  try {
    const result = await deploy(deployContext([defaultsItem(true)]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), { isEnabled: true })
    assert.match(String(result.message), /enabled/)
  } finally {
    restore()
  }
})

test('a non-boolean canvas value falls back to disabled rather than enforcing', async () => {
  const { calls, restore } = recordFetch([TOKEN, live(false), NO_CONTENT])
  try {
    await deploy(deployContext([defaultsItem('yes')]))

    // Only true / 'true' count as enabled — anything else must not switch the
    // tenant's baseline enforcement on.
    assert.deepEqual(bodyOf(writeCalls(calls)[0]), { isEnabled: false })
  } finally {
    restore()
  }
})

test('deploy records the LIVE prior value, not the value it just sent', async () => {
  const { calls, restore } = recordFetch([TOKEN, live(true), NO_CONTENT])
  try {
    const result = await deploy(deployContext([defaultsItem(false)]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true, 'the singleton always pre-exists — it is never created')
    // Rollback has to put back what the tenant HAD, not what the canvas wanted.
    assert.deepEqual(entries[0].prior, { isEnabled: true })
    assert.notDeepEqual(entries[0].prior, bodyOf(writeCalls(calls)[0]))
  } finally {
    restore()
  }
})

test('a live policy that omits isEnabled is recorded as disabled rather than undefined', async () => {
  const { restore } = recordFetch([TOKEN, resource({ id: 'sd-1' }), NO_CONTENT])
  try {
    const result = await deploy(deployContext([defaultsItem(true)]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    // An undefined prior would make rollback PATCH `{isEnabled: undefined}`,
    // which Graph drops — the tenant would keep the deployed value forever.
    assert.deepEqual(entries[0].prior, { isEnabled: false })
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([
    TOKEN,
    live(false),
    graphError(400, 'Security defaults cannot be enabled while Conditional Access policies exist.', 'BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([defaultsItem(true)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to update security defaults/)
    assert.match(String(result.message), /Conditional Access policies exist/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a rejected token exchange fails the deploy without reaching Graph', async () => {
  const { calls, restore } = recordFetch([{ status: 401, body: { error: 'invalid_client' } }])
  try {
    const result = await deploy(deployContext([defaultsItem(true)]))

    assert.equal(result.success, false)
    assert.equal(vendorCalls(calls).length, 0, 'no Graph call may be attempted without a token')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
