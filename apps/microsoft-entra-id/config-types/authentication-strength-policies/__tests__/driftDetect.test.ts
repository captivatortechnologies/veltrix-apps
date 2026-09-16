// ============================================================================
// driftDetect for Entra authentication strength policies, against a fake Graph.
//
// The drift that matters here is somebody adding a weaker way in — `password`
// appended to a phishing-resistant strength lowers the bar for every Conditional
// Access policy that references it, with no policy edited and nothing else to
// notice. That, and the strength being deleted out from under those policies
// altogether, are what these pin.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const PHISHING_RESISTANT = 'fido2\nwindowsHelloForBusiness\nx509CertificateMultiFactor'
const PHISHING_RESISTANT_LIST = ['fido2', 'windowsHelloForBusiness', 'x509CertificateMultiFactor']

function strengthItem(fields: Record<string, unknown> = {}) {
  return item('Phishing-resistant MFA', {
    name: 'Phishing-resistant MFA',
    description: 'Hardware-backed factors only',
    allowedCombinations: PHISHING_RESISTANT,
    ...fields,
  })
}

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

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([strengthItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([strengthItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and, crucially, writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await driftDetect(driftContext([strengthItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live strength matches the deployed canvas', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveStrength()])])
  try {
    const result = await driftDetect(driftContext([strengthItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'GET')
    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})

test('the same combinations in a different order are not drift', async () => {
  // Graph does not promise an order; a positional compare would report drift on
  // every run and bury the real weakening when it happened.
  const { restore } = recordFetch([
    TOKEN,
    collection([liveStrength({ allowedCombinations: ['x509CertificateMultiFactor', 'fido2', 'windowsHelloForBusiness'] })]),
  ])
  try {
    const result = await driftDetect(driftContext([strengthItem()]))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})

test('a strength deleted out of band is critical drift', async () => {
  // Every Conditional Access policy that referenced it loses its bar.
  const { restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await driftDetect(driftContext([strengthItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs[0], {
      field: 'Phishing-resistant MFA',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a weaker combination added in the portal surfaces as drift', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([liveStrength({ allowedCombinations: [...PHISHING_RESISTANT_LIST, 'password'] })]),
  ])
  try {
    const result = await driftDetect(driftContext([strengthItem()]))

    assert.equal(result.diffs.length, 1)
    assert.deepEqual(result.diffs[0], {
      field: 'Phishing-resistant MFA.allowedCombinations',
      expected: 'fido2 | windowsHelloForBusiness | x509CertificateMultiFactor',
      actual: 'fido2 | windowsHelloForBusiness | x509CertificateMultiFactor | password',
      severity: 'warning',
    })
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a combination REMOVED in the portal surfaces as drift too', async () => {
  // Narrowing is drift as well: it locks out everyone who registered the factor
  // that was taken away.
  const { restore } = recordFetch([TOKEN, collection([liveStrength({ allowedCombinations: ['fido2'] })])])
  try {
    const result = await driftDetect(driftContext([strengthItem()]))

    const diff = result.diffs.find((d) => d.field === 'Phishing-resistant MFA.allowedCombinations')
    assert.ok(diff)
    assert.equal(diff.expected, 'fido2 | windowsHelloForBusiness | x509CertificateMultiFactor')
    assert.equal(diff.actual, 'fido2')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('an edited description surfaces as its own diff', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveStrength({ description: 'Edited in the portal' })])])
  try {
    const result = await driftDetect(driftContext([strengthItem()]))

    assert.deepEqual(result.diffs[0], {
      field: 'Phishing-resistant MFA.description',
      expected: 'Hardware-backed factors only',
      actual: 'Edited in the portal',
      severity: 'warning',
    })
  } finally {
    restore()
  }
})

test('a description cleared to null is compared as an empty string, not skipped', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveStrength({ description: null })])])
  try {
    const result = await driftDetect(driftContext([strengthItem()]))

    const diff = result.diffs.find((d) => d.field === 'Phishing-resistant MFA.description')
    assert.ok(diff)
    assert.equal(diff.actual, '')
  } finally {
    restore()
  }
})

test('a strength is matched case-insensitively by display name', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveStrength({ displayName: 'PHISHING-RESISTANT MFA' })])])
  try {
    const result = await driftDetect(driftContext([strengthItem()]))

    assert.deepEqual(result, { hasDrift: false, diffs: [] }, 'a case difference must not read as a deleted strength')
  } finally {
    restore()
  }
})

test('drift compares the DEPLOYED canvas, not an edit that has not been deployed yet', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveStrength()])])
  try {
    const result = await driftDetect(
      driftContext([strengthItem({ allowedCombinations: 'fido2' })], { deployedItems: [strengthItem()] }),
    )

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})
