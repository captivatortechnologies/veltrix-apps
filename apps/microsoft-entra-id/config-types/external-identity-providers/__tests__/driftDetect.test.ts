// ============================================================================
// driftDetect for external (social) identity providers, against a fake Graph.
//
// A provider that disappeared breaks sign-in for everyone who used it; one whose
// client id was repointed at a different application is worse, because sign-in
// still works — against someone else's OAuth app. Both are asserted here, along
// with the one comparison this handler must NOT attempt: the client secret is
// write-only, so it can never be checked and must never reach a persisted diff.
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

const PROVIDERS = /\/identity\/identityProviders/
const PROVIDER_SECRET = 'google-oauth-client-secret-MUST-NOT-LEAK'
const CLIENT_ID = '1234567890-abc.apps.googleusercontent.com'

function providerItem(fields: Record<string, unknown> = {}) {
  return item('Google', {
    name: 'Google',
    identityProviderType: 'Google',
    clientId: CLIENT_ID,
    clientSecret: PROVIDER_SECRET,
    ...fields,
  })
}

function liveProvider(over: Record<string, unknown> = {}) {
  return {
    id: 'Google-OAUTH',
    displayName: 'Google',
    identityProviderType: 'Google',
    clientId: CLIENT_ID,
    ...over,
  }
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([providerItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect reports nothing when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([providerItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([{ url: PROVIDERS, respond: graphError(403, 'Insufficient privileges.') }])
  try {
    const result = await driftDetect(driftContext([providerItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [], 'a listing that failed is not evidence the provider is gone')
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live provider matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([{ url: PROVIDERS, respond: collection([liveProvider()]) }])
  try {
    const result = await driftDetect(driftContext([providerItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a provider deleted in the portal is critical drift', async () => {
  const { restore } = routeFetch([{ url: PROVIDERS, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([providerItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Google', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a client id repointed at a different OAuth application surfaces as a diff', async () => {
  const { restore } = routeFetch([
    { url: PROVIDERS, respond: collection([liveProvider({ clientId: 'someone-elses-app.apps.googleusercontent.com' })]) },
  ])
  try {
    const result = await driftDetect(driftContext([providerItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Google.clientId',
        expected: CLIENT_ID,
        actual: 'someone-elses-app.apps.googleusercontent.com',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a provider replaced by a different kind of provider surfaces as a diff', async () => {
  const { restore } = routeFetch([
    { url: PROVIDERS, respond: collection([liveProvider({ identityProviderType: 'Facebook' })]) },
  ])
  try {
    const result = await driftDetect(driftContext([providerItem()]))

    const diff = result.diffs.find((d) => d.field === 'Google.identityProviderType')
    assert.ok(diff)
    assert.equal(diff.expected, 'Google')
    assert.equal(diff.actual, 'Facebook')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('a client id cleared live reads as empty, not as a match', async () => {
  const { restore } = routeFetch([{ url: PROVIDERS, respond: collection([liveProvider({ clientId: undefined })]) }])
  try {
    const result = await driftDetect(driftContext([providerItem()]))

    const diff = result.diffs.find((d) => d.field === 'Google.clientId')
    assert.ok(diff)
    assert.equal(diff.actual, '')
  } finally {
    restore()
  }
})

test('the write-only client secret is never compared and never lands in a diff', async () => {
  const { restore } = routeFetch([{ url: PROVIDERS, respond: collection([liveProvider()]) }])
  try {
    const result = await driftDetect(driftContext([providerItem()]))

    assert.deepEqual(result.diffs, [], 'Graph never returns a secret, so a secret can never be drift')
    assert.equal(
      (JSON.stringify(result) ?? '').includes(PROVIDER_SECRET),
      false,
      'diffs are persisted — the provider secret must not be in them',
    )
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a provider listed under a differently-cased name is still matched', async () => {
  const { restore } = routeFetch([{ url: PROVIDERS, respond: collection([liveProvider({ displayName: 'GOOGLE' })]) }])
  try {
    const result = await driftDetect(driftContext([providerItem()]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('drift compares the DEPLOYED canvas, not an unsaved edit', async () => {
  const { restore } = routeFetch([{ url: PROVIDERS, respond: collection([liveProvider()]) }])
  try {
    const result = await driftDetect(
      driftContext([providerItem({ clientId: 'edited-but-never-deployed' })], {
        deployedItems: [providerItem()],
      }),
    )

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
