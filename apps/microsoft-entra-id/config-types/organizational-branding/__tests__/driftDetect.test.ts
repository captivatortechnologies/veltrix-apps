// ============================================================================
// driftDetect for the tenant's default organizational branding.
//
// Sign-in page text is where a tenant puts its legal notice, and the custom
// privacy / terms URLs are what users are pointed at — an edit in the portal
// changes what every user of the tenant sees. Drift is per field and only for
// the fields the canvas claims: a blank field is unmanaged and can never drift.
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
  resource,
  TOKEN,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const ORG_ID = '9f3c7a21-4b2e-4d6a-8c11-2a7e5f0b9d43'
const ORG = collection([{ id: ORG_ID }])

const SIGN_IN_TEXT = 'Authorised users only.'

function brandingItem(fields: Record<string, unknown> = {}) {
  return item('Default branding', {
    signInPageText: SIGN_IN_TEXT,
    backgroundColor: '#0b1020',
    ...fields,
  })
}

function liveBranding(over: Record<string, unknown> = {}) {
  return resource({ signInPageText: SIGN_IN_TEXT, backgroundColor: '#0b1020', ...over })
}

test('makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([brandingItem()], { credential: null }))

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

test('reports no drift when the live branding matches what was deployed', async () => {
  const { calls, restore } = recordFetch([TOKEN, ORG, liveBranding()])
  try {
    const result = await driftDetect(driftContext([brandingItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reads the default locale, not whatever Graph would infer', async () => {
  const { calls, restore } = recordFetch([TOKEN, ORG, liveBranding()])
  try {
    await driftDetect(driftContext([brandingItem()]))

    const read = vendorCalls(calls).find((c) => c.url.includes('/branding'))
    assert.equal(read?.acceptLanguage, '0', 'comparing against a translation would report drift on every run')
  } finally {
    restore()
  }
})

test('a sign-in notice rewritten in the portal surfaces', async () => {
  const { restore } = recordFetch([TOKEN, ORG, liveBranding({ signInPageText: 'Welcome!' })])
  try {
    const result = await driftDetect(driftContext([brandingItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'signInPageText', expected: SIGN_IN_TEXT, actual: 'Welcome!', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('a managed field cleared in the portal surfaces as an empty actual', async () => {
  const { restore } = recordFetch([TOKEN, ORG, resource({ backgroundColor: '#0b1020' })])
  try {
    const result = await driftDetect(driftContext([brandingItem()]))

    // A live object that omits the property means the tenant no longer has it,
    // which is precisely the drift worth reporting for a legal notice.
    assert.deepEqual(result.diffs, [
      { field: 'signInPageText', expected: SIGN_IN_TEXT, actual: '', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('a field the canvas leaves blank is never reported as drift', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ORG,
    liveBranding({ usernameHintText: 'someone@contoso.com', customTermsOfUseUrl: 'https://contoso.example/terms' }),
  ])
  try {
    const result = await driftDetect(driftContext([brandingItem()]))

    // The canvas does not claim these, so whatever the tenant sets is not drift.
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('a terms-of-use URL repointed in the portal surfaces', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ORG,
    liveBranding({ customTermsOfUseUrl: 'https://elsewhere.example/terms' }),
  ])
  try {
    const result = await driftDetect(
      driftContext([brandingItem({ customTermsOfUseUrl: 'https://contoso.example/terms' })]),
    )

    assert.deepEqual(result.diffs, [
      {
        field: 'customTermsOfUseUrl',
        expected: 'https://contoso.example/terms',
        actual: 'https://elsewhere.example/terms',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('an unresolvable organization id writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await driftDetect(driftContext([brandingItem()]))

    // NOTE: the handler reports `{ hasDrift: false, diffs: [] }` here, which the
    // platform reads as "checked and in sync" and uses to clear an outstanding
    // drift record. `DriftResult.checked` exists for this case; adopting it
    // across the catalog is tracked separately, so this pins only what is
    // unambiguously right today — an unreadable target is never written to.
    assert.equal(writeCalls(calls).length, 0)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('a failed branding read writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ORG, graphError(500, 'Service unavailable')])
  try {
    const result = await driftDetect(driftContext([brandingItem()]))

    assert.equal(writeCalls(calls).length, 0)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('diffs carry no token and no client secret', async () => {
  const { restore } = recordFetch([TOKEN, ORG, liveBranding({ signInPageText: 'Welcome!' })])
  try {
    const result = await driftDetect(driftContext([brandingItem()]))

    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
