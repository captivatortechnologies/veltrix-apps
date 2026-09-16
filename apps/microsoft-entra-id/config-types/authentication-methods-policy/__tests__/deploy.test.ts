// ============================================================================
// deploy for the Entra authentication methods policy, against a fake Graph.
//
// Each method configuration is a fixed TENANT SINGLETON: Graph creates them, so
// deploy only ever reads one and PATCHes its `state`. That one word decides
// whether a whole tenant may sign in with SMS, with a FIDO2 key, or with a
// Temporary Access Pass — so the assertions below are about the exact `state`
// and `@odata.type` put on the wire, and about the LIVE prior state being read
// before the write so rollback has somewhere to go back to.
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
import { METHOD_ODATA_TYPES } from '../validate'

const BASE = '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations'

function methodItem(method: string, state?: string) {
  return item(method, state === undefined ? { method } : { method, state })
}

/** One method configuration as Graph returns it for `?$select=id,state`. */
function liveMethod(id: string, state: string) {
  return resource({ id, state })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([methodItem('sms', 'enabled')], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('deploy refuses when the directory (tenant) id setting is missing', async () => {
  // Graph auth is per-tenant: with no directory id there is no token endpoint,
  // so the handler must stop before it reaches the network.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([methodItem('sms', 'enabled')], { settings: {} }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('deploy authenticates, reads the method config, then PATCHes its state', async () => {
  const { calls, restore } = recordFetch([TOKEN, liveMethod('fido2', 'disabled'), NO_CONTENT])
  try {
    const result = await deploy(deployContext([methodItem('fido2', 'enabled')]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 2)

    // Read first — the prior state is the only thing rollback can restore.
    assert.equal(graphCalls[0].method, 'GET')
    assert.ok(graphCalls[0].url.includes(`${BASE}/fido2?$select=id,state`))

    assert.equal(graphCalls[1].method, 'PATCH')
    assert.ok(graphCalls[1].url.endsWith(`${BASE}/fido2`), `PATCH target was ${graphCalls[1].url}`)
    assert.deepEqual(bodyOf(graphCalls[1]), {
      '@odata.type': METHOD_ODATA_TYPES.fido2,
      state: 'enabled',
    })

    assert.equal(result.success, true)
    assert.match(String(result.message), /Updated 1 authentication method/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a method with no state on the canvas is sent DISABLED, never enabled by default', async () => {
  // An absent `state` must not be read as "leave it on" or "turn it on" — the
  // only safe reading of silence is that the method is not permitted.
  const { calls, restore } = recordFetch([TOKEN, liveMethod('sms', 'enabled'), NO_CONTENT])
  try {
    const result = await deploy(deployContext([methodItem('sms')]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0]), {
      '@odata.type': METHOD_ODATA_TYPES.sms,
      state: 'disabled',
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('each declared method carries its own @odata.type discriminator', async () => {
  // The wrong discriminator on a PATCH silently addresses a different method
  // configuration, so this pins the pairing method-by-method.
  const { calls, restore } = recordFetch([
    TOKEN,
    liveMethod('temporaryAccessPass', 'disabled'),
    NO_CONTENT,
    liveMethod('x509Certificate', 'disabled'),
    NO_CONTENT,
  ])
  try {
    const result = await deploy(
      deployContext([methodItem('temporaryAccessPass', 'enabled'), methodItem('x509Certificate', 'disabled')]),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)
    assert.ok(writes[0].url.endsWith(`${BASE}/temporaryAccessPass`))
    assert.deepEqual(bodyOf(writes[0]), {
      '@odata.type': METHOD_ODATA_TYPES.temporaryAccessPass,
      state: 'enabled',
    })
    assert.ok(writes[1].url.endsWith(`${BASE}/x509Certificate`))
    assert.deepEqual(bodyOf(writes[1]), {
      '@odata.type': METHOD_ODATA_TYPES.x509Certificate,
      state: 'disabled',
    })
    assert.match(String(result.message), /Updated 2 authentication method/)
  } finally {
    restore()
  }
})

test('deploy records the LIVE prior state, not the state it is about to send', async () => {
  // The tenant currently allows voice calls; the canvas turns them off. Rollback
  // has to be able to put `enabled` back, so the recorded prior must be the value
  // read from Graph — not the canvas value, which would make rollback a no-op.
  const { calls, restore } = recordFetch([TOKEN, liveMethod('voice', 'enabled'), NO_CONTENT])
  try {
    const result = await deploy(deployContext([methodItem('voice', 'disabled')]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].method, 'voice')
    assert.equal(entries[0].existed, true, 'a method configuration always already exists')
    assert.deepEqual(entries[0].prior, { '@odata.type': METHOD_ODATA_TYPES.voice, state: 'enabled' })

    const sent = bodyOf(writeCalls(calls)[0])
    assert.deepEqual(sent, { '@odata.type': METHOD_ODATA_TYPES.voice, state: 'disabled' })
    assert.notDeepEqual(entries[0].prior, sent, 'the prior must be the live state, not the desired one')
  } finally {
    restore()
  }
})

test('a method Graph does not know about is dropped before any call is made', async () => {
  // The canvas can only be deployed against the fixed set of method ids; an
  // unknown one has no @odata.type, so a PATCH for it would be malformed.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([methodItem('passkeyOverCarrierPigeon', 'enabled')]))

    assert.equal(vendorCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(result.rollbackData, { entries: [] })
  } finally {
    restore()
  }
})

test('a rejected PATCH fails that method, reports the reason, and does not throw', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    liveMethod('email', 'disabled'),
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(deployContext([methodItem('email', 'enabled')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some authentication methods failed/)
    assert.match(String(result.message), /email: .*Insufficient privileges/)
    assert.equal(writeCalls(calls).length, 1)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a failure on one method still records rollback state for the ones that landed', async () => {
  // A half-applied deploy must hand back what it did change, or the change is
  // unrecoverable. The successful method is recorded; the rejected one is not.
  const { restore } = recordFetch([
    TOKEN,
    liveMethod('softwareOath', 'enabled'),
    NO_CONTENT,
    liveMethod('hardwareOath', 'disabled'),
    graphError(400, 'Hardware OATH tokens are not licensed.', 'Request_BadRequest'),
  ])
  try {
    const result = await deploy(
      deployContext([methodItem('softwareOath', 'disabled'), methodItem('hardwareOath', 'enabled')]),
    )

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].method, 'softwareOath')
    assert.deepEqual(entries[0].prior, { '@odata.type': METHOD_ODATA_TYPES.softwareOath, state: 'enabled' })
    assert.match(String(result.message), /not licensed/)
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
    const result = await deploy(deployContext([methodItem('sms', 'enabled')]))

    assert.equal(result.success, false)
    assert.equal(vendorCalls(calls).length, 0, 'no Graph request may be attempted without a token')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
