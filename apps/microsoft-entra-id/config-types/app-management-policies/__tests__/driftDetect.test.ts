// ============================================================================
// driftDetect for Entra app management policies, against a fake Microsoft Graph.
//
// Two ways this policy quietly stops protecting anything: it gets switched off,
// or its restrictions get edited. Both must surface as diffs. The third — and
// the easiest to miss — is that the policy is still enabled and still correct
// but no longer ASSIGNED to the application it was written for, at which point
// it restricts nothing at all. That is the `appliesTo` diff below.
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

const APPLIES_TO = /\/policies\/appManagementPolicies\/[^/]+\/appliesTo/
const LIST = /\/policies\/appManagementPolicies\?\$select=/
const APP_MAP = /\/applications\?\$select=id,displayName$/
const SP_MAP = /\/servicePrincipals\?\$select=id,displayName$/

const RESTRICTIONS = { passwordCredentials: [{ restrictionType: 'passwordAddition', state: 'enabled' }] }
const RESTRICTIONS_JSON = '{"passwordCredentials":[{"restrictionType":"passwordAddition","state":"enabled"}]}'

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    displayName: 'No app passwords',
    description: 'Block password credentials',
    isEnabled: true,
    restrictions: RESTRICTIONS,
    ...over,
  }
}

function policyItem(fields: Record<string, unknown> = {}) {
  return item('No app passwords', {
    name: 'No app passwords',
    isEnabled: true,
    restrictions: JSON.stringify(RESTRICTIONS),
    ...fields,
  })
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

test('reports no drift when the live policy matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: APPLIES_TO, respond: collection([]) },
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted policy is critical drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'No app passwords', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a policy switched off and its restrictions edited both surface', async () => {
  const { restore } = routeFetch([
    { url: APPLIES_TO, respond: collection([]) },
    {
      url: LIST,
      respond: collection([
        livePolicy({
          isEnabled: false,
          restrictions: { passwordCredentials: [{ restrictionType: 'passwordAddition', state: 'disabled' }] },
        }),
      ]),
    },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'No app passwords.isEnabled', expected: 'true', actual: 'false', severity: 'warning' },
      {
        field: 'No app passwords.restrictions',
        expected: RESTRICTIONS_JSON,
        actual: '{"passwordCredentials":[{"restrictionType":"passwordAddition","state":"disabled"}]}',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('restrictions written with their keys in another order are not drift', async () => {
  const { restore } = routeFetch([
    { url: APPLIES_TO, respond: collection([]) },
    {
      url: LIST,
      respond: collection([
        livePolicy({ restrictions: { passwordCredentials: [{ state: 'enabled', restrictionType: 'passwordAddition' }] } }),
      ]),
    },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem()]))

    assert.deepEqual(result.diffs, [], 'key order carries no meaning, so it must not read as drift')
  } finally {
    restore()
  }
})

test('a policy unassigned from its application is drift, even while the policy itself is intact', async () => {
  const { restore } = routeFetch([
    { url: APPLIES_TO, respond: collection([]) },
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APP_MAP, respond: collection([{ id: 'app-1', displayName: 'Contoso API' }]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Contoso API'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'No app passwords.appliesTo',
        expected: '["app-1"]',
        actual: '[]',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('an extra live assignment alone is not drift', async () => {
  const { restore } = routeFetch([
    {
      url: APPLIES_TO,
      respond: collection([
        { id: 'app-1', '@odata.type': '#microsoft.graph.application' },
        { id: 'sp-extra', '@odata.type': '#microsoft.graph.servicePrincipal' },
      ]),
    },
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APP_MAP, respond: collection([{ id: 'app-1', displayName: 'Contoso API' }]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Contoso API'] })]))

    assert.deepEqual(result.diffs, [], 'this app never unassigns what it did not assign')
  } finally {
    restore()
  }
})

test('an appliesTo target that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: APPLIES_TO, respond: collection([]) },
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APP_MAP, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([policyItem({ appliesTo: ['Ghost App'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'No app passwords.appliesTo',
        expected: 'resolvable',
        actual: 'unknown target(s): Ghost App',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})
