// ============================================================================
// driftDetect for Entra token lifetime policies, against a fake Microsoft Graph.
//
// The drift that matters most here is `isOrganizationDefault` flipping on out
// of band: that one boolean rewrites token lifetimes tenant-wide, so it gets
// its own diff rather than being folded into the definition comparison. The
// definition itself is compared in CANONICAL form, so a portal edit that only
// reorders JSON keys is not drift while a changed lifetime is.
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

const LIST = /\/policies\/tokenLifetimePolicies\?\$select=/
const APPLIES_TO = /\/policies\/tokenLifetimePolicies\/[^/]+\/appliesTo/
const APP_MAP = /\/applications\?\$select=id,displayName/
const SP_MAP = /\/servicePrincipals\?\$select=id,displayName/

const WANT = '{"TokenLifetimePolicy":{"Version":1,"AccessTokenLifetime":"04:00:00"}}'
const WANT_REORDERED = '{"TokenLifetimePolicy":{"AccessTokenLifetime":"04:00:00","Version":1}}'
const DRIFTED = '{"TokenLifetimePolicy":{"Version":1,"AccessTokenLifetime":"23:00:00"}}'

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    displayName: 'Short Access Tokens',
    definition: [WANT],
    isOrganizationDefault: false,
    ...over,
  }
}

function policyItem(fields: Record<string, unknown> = {}) {
  return item('Short Access Tokens', { name: 'Short Access Tokens', definition: WANT, ...fields })
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
      field: 'Short Access Tokens',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
  } finally {
    restore()
  }
})

test('a lifetime edited in the portal surfaces as a canonical-form diff', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ definition: [DRIFTED] })]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Short Access Tokens.definition',
        expected: '{"TokenLifetimePolicy":{"AccessTokenLifetime":"04:00:00","Version":1}}',
        actual: '{"TokenLifetimePolicy":{"AccessTokenLifetime":"23:00:00","Version":1}}',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a policy that became the organization default out of band is its own diff', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ isOrganizationDefault: true })]) },
    { url: APPLIES_TO, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: 'Short Access Tokens.isOrganizationDefault',
        expected: 'false',
        actual: 'true',
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
    { url: SP_MAP, respond: collection([{ id: 'sp-1', displayName: 'Contoso API' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Contoso API'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Short Access Tokens.appliesTo',
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
    { url: SP_MAP, respond: collection([{ id: 'sp-1', displayName: 'Contoso API' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Contoso API'] })]))

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
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Ghost API'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Short Access Tokens.appliesTo',
        expected: 'resolvable',
        actual: 'unknown target(s): Ghost API',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})
