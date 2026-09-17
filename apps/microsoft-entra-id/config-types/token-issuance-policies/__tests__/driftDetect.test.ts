// ============================================================================
// driftDetect for Entra token issuance policies, against a fake Microsoft Graph.
//
// The definition is compared in CANONICAL form, so a portal edit that only
// reorders JSON keys is not drift while a changed signing algorithm is. The
// assignment comparison is deliberately one-sided: a DECLARED application that
// no longer carries the policy is drift, while an EXTRA live assignment is not
// — the same "never touch what we did not add" rule deploy encodes.
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

const LIST = /\/policies\/tokenIssuancePolicies\?\$select=/
const APPLIES_TO = /\/policies\/tokenIssuancePolicies\/[^/]+\/appliesTo/
const APP_MAP = /\/applications\?\$select=id,displayName/
const SP_MAP = /\/servicePrincipals\?\$select=id,displayName/

/** Declared by the canvas. */
const WANT = '{"TokenIssuancePolicy":{"Version":1,"SigningAlgorithm":"rsa-sha256"}}'
/** The same policy with its JSON keys written in the other order. */
const WANT_REORDERED = '{"TokenIssuancePolicy":{"SigningAlgorithm":"rsa-sha256","Version":1}}'
/** Someone downgraded the signing algorithm in the portal. */
const DRIFTED = '{"TokenIssuancePolicy":{"Version":1,"SigningAlgorithm":"rsa-sha1"}}'

function livePolicy(over: Record<string, unknown> = {}) {
  return { id: 'p-1', displayName: 'SAML Token Issuance', definition: [WANT], ...over }
}

function policyItem(fields: Record<string, unknown> = {}) {
  return item('SAML Token Issuance', { name: 'SAML Token Issuance', definition: WANT, ...fields })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([policyItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live policy matches, even with its JSON keys reordered', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ definition: [WANT_REORDERED] })]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.deepEqual(result.diffs, [], 'key order is not a semantic difference')
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted policy is critical drift', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs[0], {
      field: 'SAML Token Issuance',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
  } finally {
    restore()
  }
})

test('a signing definition edited in the portal surfaces as a canonical-form diff', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ definition: [DRIFTED] })]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: 'SAML Token Issuance.definition',
        expected: '{"TokenIssuancePolicy":{"SigningAlgorithm":"rsa-sha256","Version":1}}',
        actual: '{"TokenIssuancePolicy":{"SigningAlgorithm":"rsa-sha1","Version":1}}',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a declared application that no longer carries the policy is drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO, respond: collection([{ id: 'a-other', '@odata.type': '#microsoft.graph.application' }]) },
    { url: APP_MAP, respond: collection([{ id: 'a-1', displayName: 'Contoso Portal' }]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Contoso Portal'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'SAML Token Issuance.appliesTo',
        expected: '["a-1"]',
        actual: '["a-other"]',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('an extra live assignment alone is not reported as drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    {
      url: APPLIES_TO,
      respond: collection([
        { id: 'a-1', '@odata.type': '#microsoft.graph.application' },
        { id: 'a-extra', '@odata.type': '#microsoft.graph.application' },
      ]),
    },
    { url: APP_MAP, respond: collection([{ id: 'a-1', displayName: 'Contoso Portal' }]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Contoso Portal'] })]))

    assert.deepEqual(result.diffs, [], 'this app never revokes what it did not assign, so extras are not its drift')
  } finally {
    restore()
  }
})

test('an appliesTo name that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Ghost App'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'SAML Token Issuance.appliesTo',
        expected: 'resolvable',
        actual: 'unknown target(s): Ghost App',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})
