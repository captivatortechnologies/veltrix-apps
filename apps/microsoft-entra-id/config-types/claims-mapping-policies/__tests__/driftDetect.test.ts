// ============================================================================
// driftDetect for Entra claims mapping policies, against a fake Microsoft Graph.
//
// A claim quietly added to (or dropped from) a token is an authorization change
// at the relying party, so the definition comparison is the point of this
// handler. It runs in CANONICAL form: a portal edit that only reorders JSON
// keys is not drift, while an added ClaimsSchema entry is.
//
// The assignment comparison is deliberately one-sided: a DECLARED service
// principal that no longer carries the policy is drift, an EXTRA live one is
// not — the same "never touch what we did not add" rule deploy encodes.
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

const LIST = /\/policies\/claimsMappingPolicies\?\$select=/
const APPLIES_TO = /\/policies\/claimsMappingPolicies\/[^/]+\/appliesTo/
const APP_MAP = /\/applications\?\$select=id,displayName/
const SP_MAP = /\/servicePrincipals\?\$select=id,displayName/

const WANT = '{"ClaimsMappingPolicy":{"Version":1,"IncludeBasicClaimSet":"true"}}'
const WANT_REORDERED = '{"ClaimsMappingPolicy":{"IncludeBasicClaimSet":"true","Version":1}}'
/** Someone turned the basic claim set off in the portal. */
const DRIFTED = '{"ClaimsMappingPolicy":{"Version":1,"IncludeBasicClaimSet":"false"}}'

function livePolicy(over: Record<string, unknown> = {}) {
  return { id: 'p-1', displayName: 'Employee ID Claims', definition: [WANT], ...over }
}

function policyItem(fields: Record<string, unknown> = {}) {
  return item('Employee ID Claims', { name: 'Employee ID Claims', definition: WANT, ...fields })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([policyItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
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
      field: 'Employee ID Claims',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
  } finally {
    restore()
  }
})

test('a claim set edited in the portal surfaces as a canonical-form diff', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ definition: [DRIFTED] })]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Employee ID Claims.definition',
        expected: '{"ClaimsMappingPolicy":{"IncludeBasicClaimSet":"true","Version":1}}',
        actual: '{"ClaimsMappingPolicy":{"IncludeBasicClaimSet":"false","Version":1}}',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a policy whose live definition is unparseable still reports drift rather than passing', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ definition: ['not json at all'] })]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    // An uncanonicalisable live value reads as an empty actual — reported, not
    // silently treated as a match.
    assert.deepEqual(result.diffs, [
      {
        field: 'Employee ID Claims.definition',
        expected: '{"ClaimsMappingPolicy":{"IncludeBasicClaimSet":"true","Version":1}}',
        actual: '',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a declared service principal that no longer carries the policy is drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO, respond: collection([{ id: 'sp-other', '@odata.type': '#microsoft.graph.servicePrincipal' }]) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([{ id: 'sp-1', displayName: 'Contoso HR' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Contoso HR'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Employee ID Claims.appliesTo',
        expected: '["sp-1"]',
        actual: '["sp-other"]',
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
        { id: 'sp-1', '@odata.type': '#microsoft.graph.servicePrincipal' },
        { id: 'sp-extra', '@odata.type': '#microsoft.graph.servicePrincipal' },
      ]),
    },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([{ id: 'sp-1', displayName: 'Contoso HR' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Contoso HR'] })]))

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
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Ghost HR'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Employee ID Claims.appliesTo',
        expected: 'resolvable',
        actual: 'unknown target(s): Ghost HR',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})
