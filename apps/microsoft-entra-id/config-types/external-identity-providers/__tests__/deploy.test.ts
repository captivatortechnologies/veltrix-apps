// ============================================================================
// deploy for external (social) identity providers, against a fake Graph.
//
// An identity provider configured here is a new way into the tenant: once it is
// live, anyone who can sign in at Google/Facebook/GitHub with a matching account
// can reach a B2B or self-service flow that offers it. So the assertions are
// about the exact object written — its type, its client id — and about the
// provider's OWN client secret, which is a real credential that has to reach
// Graph on the wire and must appear in NOTHING the platform stores afterwards:
// no message, no artifact, no rollbackData.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const BASE = '/identity/identityProviders'
const SOCIAL = '#microsoft.graph.socialIdentityProvider'

/** The provider's own OAuth client secret — distinct from the Entra credential. */
const PROVIDER_SECRET = 'google-oauth-client-secret-MUST-NOT-LEAK'

/** True when the configured provider secret appears anywhere in `value`. */
function leaksProviderSecret(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(PROVIDER_SECRET)
}

function providerItem(fields: Record<string, unknown> = {}) {
  return item('Google', {
    name: 'Google',
    identityProviderType: 'Google',
    clientId: '1234567890-abc.apps.googleusercontent.com',
    clientSecret: PROVIDER_SECRET,
    ...fields,
  })
}

function liveProvider(over: Record<string, unknown> = {}) {
  return {
    id: 'Google-OAUTH',
    displayName: 'Google',
    identityProviderType: 'Google',
    clientId: 'old-client-id.apps.googleusercontent.com',
    ...over,
  }
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([providerItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
    assert.equal(leaksProviderSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([providerItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed provider listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await deploy(deployContext([providerItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list identity providers/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live providers must not create a duplicate sign-in path',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates a provider that does not exist', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'Google-OAUTH' })])
  try {
    const result = await deploy(deployContext([providerItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls[0].method, 'GET')

    const post = graphCalls[1]
    assert.equal(post.method, 'POST')
    assert.ok(post.url.endsWith(BASE))
    assert.deepEqual(bodyOf(post), {
      '@odata.type': SOCIAL,
      displayName: 'Google',
      // The immutable kind of provider — only present on the create.
      identityProviderType: 'Google',
      clientId: '1234567890-abc.apps.googleusercontent.com',
      clientSecret: PROVIDER_SECRET,
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('the provider secret goes to Graph and nowhere else', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'Google-OAUTH' })])
  try {
    const result = await deploy(deployContext([providerItem()]))

    // It has to be on the wire — Graph cannot configure the provider without it.
    assert.ok(writeCalls(calls)[0].body.includes(PROVIDER_SECRET))
    // And it must be in nothing the platform keeps: message, artifacts,
    // rollbackData and diff are all persisted.
    assert.equal(leaksProviderSecret(result), false, 'the provider client secret must not be echoed back')
    assert.equal(leaksSecret(result), false, 'nor the Entra token or app-registration secret')
  } finally {
    restore()
  }
})

test('a newly created provider is recorded with the id Graph assigned it', async () => {
  const { restore } = recordFetch([TOKEN, collection([]), created({ id: 'Google-OAUTH' })])
  try {
    const result = await deploy(deployContext([providerItem()]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: undefined, name: 'Google', existed: false, id: 'Google-OAUTH' }])
    assert.equal(entries[0].prior, undefined, 'a provider this app created has no prior state to restore')
  } finally {
    restore()
  }
})

test('deploy updates a provider that already exists, without re-sending its immutable type', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveProvider()]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([providerItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing provider is patched, never duplicated')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`${BASE}/Google-OAUTH`))
    assert.deepEqual(bodyOf(writes[0]), {
      '@odata.type': SOCIAL,
      displayName: 'Google',
      clientId: '1234567890-abc.apps.googleusercontent.com',
      clientSecret: PROVIDER_SECRET,
    })
    assert.equal(
      'identityProviderType' in (bodyOf(writes[0]) ?? {}),
      false,
      'identityProviderType is immutable — sending it would have Graph reject the update',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy records the LIVE prior provider fields, and no secret with them', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveProvider()]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([providerItem()]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'Google-OAUTH')
    // The tenant's own values, not the canvas's.
    assert.deepEqual(entries[0].prior, {
      '@odata.type': SOCIAL,
      displayName: 'Google',
      clientId: 'old-client-id.apps.googleusercontent.com',
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(writeCalls(calls)[0]))
    // Graph never returns a client secret, so the recorded prior cannot carry one.
    assert.equal(leaksProviderSecret(entries[0].prior), false)
  } finally {
    restore()
  }
})

test('a provider is matched by display name case-insensitively', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveProvider({ displayName: 'GOOGLE' })]), NO_CONTENT])
  try {
    await deploy(deployContext([providerItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH', 'a case difference must not create a second sign-in path')
  } finally {
    restore()
  }
})

test('a renamed provider is found by the id the previous deploy recorded', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    collection([liveProvider({ displayName: 'Google (renamed in the portal)' })]),
    NO_CONTENT,
  ])
  try {
    const result = await deploy(
      deployContext([providerItem()], {
        priorRollbackData: { entries: [{ name: 'Google', existed: true, id: 'Google-OAUTH' }] },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`${BASE}/Google-OAUTH`), 'the tracked id wins over a name lookup')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing, and still leaks no secret', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    graphError(400, 'The client secret provided for the identity provider is invalid.', 'Request_BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([providerItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some identity providers failed/)
    assert.match(String(result.message), /client secret provided for the identity provider is invalid/)
    assert.equal(leaksProviderSecret(result), false, 'a vendor error must not quote the secret back')
    assert.equal(leaksSecret(result), false)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})

test('one failed provider does not discard the rollback state of the one that succeeded', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    created({ id: 'Google-OAUTH' }),
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(
      deployContext([providerItem(), providerItem({ name: 'GitHub', identityProviderType: 'GitHub' })]),
    )

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries.map((e) => e.id), ['Google-OAUTH'])
  } finally {
    restore()
  }
})

test('deploy deletes a provider it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired', existed: false, id: 'Retired-OAUTH' },
            { name: 'Pre-existing', existed: true, id: 'Facebook-OAUTH', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'a provider that pre-dated this app must survive the reconcile')
    assert.ok(deletes[0].url.endsWith(`${BASE}/Retired-OAUTH`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a provider still declared is not deleted by the reconcile', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveProvider()]), NO_CONTENT])
  try {
    await deploy(
      deployContext([providerItem()], {
        priorRollbackData: { entries: [{ name: 'Google', existed: false, id: 'Google-OAUTH' }] },
      }),
    )

    assert.equal(writeCalls(calls).filter((c) => c.method === 'DELETE').length, 0)
  } finally {
    restore()
  }
})

test('an item with no name at all is skipped rather than written', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await deploy(deployContext([{ name: '', fields: { clientId: 'x', clientSecret: PROVIDER_SECRET } }]))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(vendorCalls(calls).length, 1)
  } finally {
    restore()
  }
})
