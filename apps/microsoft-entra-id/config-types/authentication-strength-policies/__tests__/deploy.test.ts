// ============================================================================
// deploy for Entra authentication strength policies, against a fake Graph.
//
// An authentication strength IS the bar a Conditional Access policy enforces:
// the `allowedCombinations` list is the complete set of ways a user may satisfy
// it. Adding `password` to a phishing-resistant strength weakens every policy
// that references it, everywhere, with no other object changing. So these assert
// the exact combinations put on the wire, that the dedicated combinations action
// is used ONLY when they really differ, and that a built-in strength is never
// touched at all.
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

const BASE = '/policies/authenticationStrengthPolicies'

/** Two phishing-resistant ways in, one per line, as the canvas stores them. */
const PHISHING_RESISTANT = 'fido2\nwindowsHelloForBusiness\nx509CertificateMultiFactor'
const PHISHING_RESISTANT_LIST = ['fido2', 'windowsHelloForBusiness', 'x509CertificateMultiFactor']

function strengthItem(fields: Record<string, unknown> = {}) {
  return item('Phishing-resistant MFA', {
    name: 'Phishing-resistant MFA',
    allowedCombinations: PHISHING_RESISTANT,
    ...fields,
  })
}

/** A tenant-authored (therefore modifiable) strength as Graph lists it. */
function liveStrength(over: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    displayName: 'Phishing-resistant MFA',
    description: 'Hardware-backed factors only',
    policyType: 'custom',
    allowedCombinations: PHISHING_RESISTANT_LIST,
    ...over,
  }
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([strengthItem()], { credential: null }))

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
    const result = await deploy(deployContext([strengthItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await deploy(deployContext([strengthItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list authentication strengths/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates a strength with exactly the declared combinations', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 's-new' })])
  try {
    const result = await deploy(deployContext([strengthItem({ description: 'Hardware-backed factors only' })]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 2)
    assert.equal(graphCalls[0].method, 'GET')

    assert.equal(graphCalls[1].method, 'POST')
    assert.ok(graphCalls[1].url.endsWith(BASE), `POST target was ${graphCalls[1].url}`)
    assert.deepEqual(bodyOf(graphCalls[1]), {
      displayName: 'Phishing-resistant MFA',
      description: 'Hardware-backed factors only',
      // The whole point of the config type: nothing weaker may appear here.
      allowedCombinations: PHISHING_RESISTANT_LIST,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 's-new')
    assert.equal(entries[0].prior, undefined)
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a multi-factor combination is sent as one comma-joined entry, not split apart', async () => {
  // "password, microsoftAuthenticatorPush" is ONE way in requiring both. Split
  // into two entries it would become two ways in, each requiring only one.
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 's-new' })])
  try {
    await deploy(
      deployContext([strengthItem({ allowedCombinations: 'fido2\npassword, microsoftAuthenticatorPush' })]),
    )

    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.allowedCombinations, [
      'fido2',
      'password,microsoftAuthenticatorPush',
    ])
  } finally {
    restore()
  }
})

test('a blank description is sent as null rather than omitted', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 's-new' })])
  try {
    await deploy(deployContext([strengthItem()]))

    assert.equal(bodyOf(writeCalls(calls)[0])?.description, null)
  } finally {
    restore()
  }
})

test('deploy updates an existing custom strength and records its LIVE prior combinations', async () => {
  // The tenant currently accepts a password + push combination; the canvas
  // removes it. Rollback must be able to put the old list back verbatim.
  const live = liveStrength({ allowedCombinations: ['fido2', 'password,microsoftAuthenticatorPush'] })
  const { calls, restore } = recordFetch([TOKEN, collection([live]), NO_CONTENT, NO_CONTENT])
  try {
    const result = await deploy(deployContext([strengthItem({ description: 'Tightened' })]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)

    // Metadata goes through PATCH...
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`${BASE}/s-1`))
    assert.deepEqual(bodyOf(writes[0]), { displayName: 'Phishing-resistant MFA', description: 'Tightened' })

    // ...the combinations only through the dedicated action Graph requires.
    assert.equal(writes[1].method, 'POST')
    assert.ok(writes[1].url.endsWith(`${BASE}/s-1/updateAllowedCombinations`))
    assert.deepEqual(bodyOf(writes[1]), { allowedCombinations: PHISHING_RESISTANT_LIST })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.deepEqual(entries[0].prior, {
      displayName: 'Phishing-resistant MFA',
      description: 'Hardware-backed factors only',
      allowedCombinations: ['fido2', 'password,microsoftAuthenticatorPush'],
    })
    assert.notDeepEqual(
      (entries[0].prior as { allowedCombinations: string[] }).allowedCombinations,
      PHISHING_RESISTANT_LIST,
      'the prior must be the live list, not the desired one',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('combinations that already match are not re-sent, however they are ordered', async () => {
  // Re-issuing updateAllowedCombinations on every deploy is a write against the
  // control that gates every step-up policy — it must happen only on a real change.
  const live = liveStrength({
    allowedCombinations: ['x509CertificateMultiFactor', 'windowsHelloForBusiness', 'fido2'],
  })
  const { calls, restore } = recordFetch([TOKEN, collection([live]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([strengthItem({ description: 'Hardware-backed factors only' })]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'only the metadata PATCH should have been sent')
    assert.equal(writes[0].method, 'PATCH')
    assert.equal(
      writes.filter((c) => c.url.includes('updateAllowedCombinations')).length,
      0,
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('mode order WITHIN a combination is also treated as equal, not as a change', async () => {
  const live = liveStrength({ allowedCombinations: ['microsoftAuthenticatorPush,password'] })
  const { calls, restore } = recordFetch([TOKEN, collection([live]), NO_CONTENT])
  try {
    await deploy(
      deployContext([
        strengthItem({ allowedCombinations: 'password, microsoftAuthenticatorPush', description: 'Hardware-backed factors only' }),
      ]),
    )

    assert.equal(writeCalls(calls).length, 1)
  } finally {
    restore()
  }
})

test('a built-in strength with the same name is refused, and nothing at all is written', async () => {
  // Graph's built-in strengths cannot be modified; attempting it would fail
  // anyway, but the guard has to stop BEFORE the PATCH, not after.
  const { calls, restore } = recordFetch([TOKEN, collection([liveStrength({ policyType: 'builtIn' })])])
  try {
    const result = await deploy(deployContext([strengthItem()]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /built-in authentication strength with this name exists and will not be modified/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a live strength with no policyType is treated as built-in, not as modifiable', async () => {
  // Unknown provenance must fail closed: modifying a strength the app does not
  // own is how a tenant's own MFA bar gets silently rewritten.
  const { calls, restore } = recordFetch([TOKEN, collection([liveStrength({ policyType: undefined })])])
  try {
    const result = await deploy(deployContext([strengthItem()]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
  } finally {
    restore()
  }
})

test('a strength renamed in the portal is matched by its recorded id, not duplicated', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    collection([liveStrength({ displayName: 'Renamed in the portal' })]),
    NO_CONTENT,
  ])
  try {
    const result = await deploy(
      deployContext([strengthItem({ description: 'Hardware-backed factors only' })], {
        priorRollbackData: { entries: [{ name: 'Phishing-resistant MFA', existed: true, id: 's-1', prior: {} }] },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH', 'a rename must not become a create')
    assert.ok(writes[0].url.endsWith(`${BASE}/s-1`))
    assert.equal(bodyOf(writes[0])?.displayName, 'Phishing-resistant MFA')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an item with no name is skipped — nothing is written for it', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await deploy(deployContext([item('', { allowedCombinations: PHISHING_RESISTANT })]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(result.rollbackData, { entries: [] })
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    graphError(400, 'allowedCombinations contains an unsupported mode.', 'Request_BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([strengthItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some authentication strengths failed/)
    assert.match(String(result.message), /Phishing-resistant MFA: .*unsupported mode/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a failure on one strength still records rollback state for the one that landed', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    created({ id: 's-new' }),
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(
      deployContext([strengthItem(), strengthItem({ name: 'Finance step-up' })]),
    )

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, 's-new')
  } finally {
    restore()
  }
})

test('reconcile deletes a strength this app created and no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: { entries: [{ name: 'Retired strength', existed: false, id: 's-old' }] },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.ok(deletes[0].url.endsWith(`${BASE}/s-old`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reconcile leaves a strength that pre-existed this app alone', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveStrength({ id: 's-keep' })])])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Pre-existing strength', existed: true, id: 's-keep', prior: { displayName: 'Pre-existing strength' } },
          ],
        },
      }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a rejected token exchange stops the deploy without a single Graph call', async () => {
  const { calls, restore } = recordFetch([
    { status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' } },
  ])
  try {
    const result = await deploy(deployContext([strengthItem()]))

    assert.equal(result.success, false)
    assert.equal(vendorCalls(calls).length, 0, 'no Graph request may be attempted without a token')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

