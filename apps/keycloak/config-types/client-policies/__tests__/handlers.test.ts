// =============================================================================
// Keycloak Client Policies — deploy / rollback / healthCheck / driftDetect /
// getStatus driven end to end against the fake Keycloak.
//
// `client-policies/policies` is a realm-wide WHOLE-LIST singleton: one read,
// one write, covering every declared item together. Two consequences drive
// these tests — a failed read must stop the handler before it replaces the
// realm's entire policy list, and `globalPolicies` (Keycloak's own built-ins)
// must never be echoed from the GET back into the PUT.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import rollback from '../rollback'
import healthCheck from '../healthCheck'
import driftDetect from '../driftDetect'
import getStatus from '../getStatus'
import {
  TOKEN,
  adminPath,
  bodyOf,
  deployContext,
  driftContext,
  isTokenCall,
  item,
  kcError,
  leaksToken,
  noContent,
  ok,
  recordKeycloak,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeKeycloak'
import { describeHealthCheckContract } from '../../../lib/__tests__/healthCheckContract'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

const FAPI_POLICY = {
  name: 'fapi-clients',
  description: 'Apply the FAPI profile to partner clients',
  enabled: true,
  conditions: JSON.stringify([{ condition: 'client-roles', configuration: { roles: ['partner'] } }]),
  profiles: ['fapi-1-advanced', 'org-baseline'],
}

/** Keycloak's own built-in policies, which this config type never authors. */
const GLOBAL_POLICIES = [{ name: 'builtin-policy', enabled: true, conditions: [], profiles: [] }]

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    name: 'fapi-clients',
    description: 'Apply the FAPI profile to partner clients',
    enabled: true,
    conditions: [{ condition: 'client-roles', configuration: { roles: ['partner'] } }],
    profiles: ['fapi-1-advanced', 'org-baseline'],
    ...over,
  }
}

// --- deploy -------------------------------------------------------------------

test('client-policies deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('fapi', FAPI_POLICY)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-policies deploy stops before writing when the current list cannot be read', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await deploy(deployContext([item('fapi', FAPI_POLICY)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /read client-policies\/policies/)
    assert.match(String(result.message), /503/)
    // The PUT replaces the realm's ENTIRE custom policy list. Sending it after
    // a failed read would silently delete every policy already there.
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('client-policies deploy reads the current list, then writes the complete desired list', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok({ policies: [livePolicy({ name: 'legacy' })], globalPolicies: GLOBAL_POLICIES }),
    noContent(),
  ])
  try {
    const result = await deploy(deployContext([item('fapi', FAPI_POLICY)]))

    assert.ok(isTokenCall(calls[0]))
    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /client-policies/policies', 'PUT /client-policies/policies'],
    )

    const body = bodyOf(vendor[1]) as { policies: Array<Record<string, unknown>> }
    assert.equal(body.policies.length, 1)
    assert.equal(body.policies[0].name, 'fapi-clients')
    assert.equal(body.policies[0].enabled, true)
    assert.deepEqual(body.policies[0].conditions, [
      { condition: 'client-roles', configuration: { roles: ['partner'] } },
    ])
    assert.deepEqual(body.policies[0].profiles, ['fapi-1-advanced', 'org-baseline'])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('client-policies deploy never echoes globalPolicies from the read into the write', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok({ policies: [], globalPolicies: GLOBAL_POLICIES }),
    noContent(),
  ])
  try {
    await deploy(deployContext([item('fapi', FAPI_POLICY)]))

    const body = bodyOf(vendorCalls(calls)[1]) as Record<string, unknown>
    // Keycloak rejects a globalPolicies value that differs from the live
    // built-ins outright; the only sanctioned PUT shape is { policies }.
    assert.deepEqual(Object.keys(body), ['policies'])
  } finally {
    restore()
  }
})

test('client-policies deploy records the exact prior list for rollback, not the desired one', async () => {
  const prior = [livePolicy({ name: 'legacy', enabled: false })]
  const { restore } = recordKeycloak([TOKEN, ok({ policies: prior, globalPolicies: GLOBAL_POLICIES }), noContent()])
  try {
    const result = await deploy(deployContext([item('fapi', FAPI_POLICY)]))

    const data = result.rollbackData as { priorPolicies: unknown[] }
    assert.deepEqual(data.priorPolicies, prior)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('client-policies deploy records an empty prior list rather than nothing when the realm had none', async () => {
  const { restore } = recordKeycloak([TOKEN, ok({ policies: [] }), noContent()])
  try {
    const result = await deploy(deployContext([item('fapi', FAPI_POLICY)]))

    const data = result.rollbackData as { priorPolicies: unknown[] }
    // "No policies" is a state to restore to, not an absence of state.
    assert.deepEqual(data.priorPolicies, [])
  } finally {
    restore()
  }
})

test('client-policies deploy fails before writing when a policy declares unparseable conditions', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok({ policies: [] })])
  try {
    const result = await deploy(deployContext([item('fapi', { ...FAPI_POLICY, conditions: '{not json' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Client policy "fapi-clients"/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('client-policies deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, ok({ policies: [] }), kcError(400, 'Global policies cannot be updated')])
  try {
    const result = await deploy(deployContext([item('fapi', FAPI_POLICY)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /400/)
  } finally {
    restore()
  }
})

test('client-policies deploy drops an item with a blank name from the written list', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok({ policies: [] }), noContent()])
  try {
    const result = await deploy(
      deployContext([item('blank', { ...FAPI_POLICY, name: '' }), item('fapi', FAPI_POLICY)]),
    )

    const body = bodyOf(vendorCalls(calls)[1]) as { policies: Array<{ name: string }> }
    assert.deepEqual(
      body.policies.map((p) => p.name),
      ['fapi-clients'],
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('client-policies rollback refuses when no prior list was recorded', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, false)
    assert.match(String(result.message), /No previous state/)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-policies rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ priorPolicies: [livePolicy()] }, { credential: null }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-policies rollback restores the prior list verbatim with one write', async () => {
  const prior = [livePolicy({ name: 'legacy', enabled: false })]
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ priorPolicies: prior }))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['PUT /client-policies/policies'],
    )
    assert.deepEqual(bodyOf(vendor[0]), { policies: prior })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('client-policies rollback restores an empty prior list instead of treating it as a no-op', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ priorPolicies: [] }))

    assert.equal(result.success, true)
    // Skipping this would leave the deploy's policies in force forever.
    assert.deepEqual(bodyOf(vendorCalls(calls)[0]), { policies: [] })
  } finally {
    restore()
  }
})

test('client-policies rollback reports failure rather than throwing when the write is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(rollbackContext({ priorPolicies: [livePolicy()] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('client-policies driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('fapi', FAPI_POLICY)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-policies driftDetect reports no drift when the live policy matches', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok({ policies: [livePolicy()] })])
  try {
    const result = await driftDetect(driftContext([item('fapi', FAPI_POLICY)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('client-policies driftDetect treats a declared policy missing from the realm as critical', async () => {
  const { restore } = recordKeycloak([TOKEN, ok({ policies: [] })])
  try {
    const result = await driftDetect(driftContext([item('fapi', FAPI_POLICY)]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].field, 'fapi-clients')
    assert.equal(result.diffs[0].actual, 'missing')
    // A successful prior deploy should have created it — this is not a warning.
    assert.equal(result.diffs[0].severity, 'critical')
  } finally {
    restore()
  }
})

test('client-policies driftDetect reports a policy disabled out of band', async () => {
  const { restore } = recordKeycloak([TOKEN, ok({ policies: [livePolicy({ enabled: false })] })])
  try {
    const result = await driftDetect(driftContext([item('fapi', FAPI_POLICY)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['fapi-clients.enabled'],
    )
  } finally {
    restore()
  }
})

test('client-policies driftDetect treats a missing enabled flag as disabled, matching Keycloak', async () => {
  const live = livePolicy()
  delete (live as Record<string, unknown>).enabled
  const { restore } = recordKeycloak([TOKEN, ok({ policies: [live] })])
  try {
    const result = await driftDetect(driftContext([item('fapi', FAPI_POLICY)]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].field, 'fapi-clients.enabled')
    assert.equal(result.diffs[0].actual, false)
  } finally {
    restore()
  }
})

test('client-policies driftDetect compares conditions by order and profiles as a set', async () => {
  const reorderedProfiles = recordKeycloak([
    TOKEN,
    ok({ policies: [livePolicy({ profiles: ['org-baseline', 'fapi-1-advanced'] })] }),
  ])
  try {
    const result = await driftDetect(driftContext([item('fapi', FAPI_POLICY)]))
    assert.equal(result.hasDrift, false, 'profile application order does not matter')
  } finally {
    reorderedProfiles.restore()
  }

  const changedCondition = recordKeycloak([
    TOKEN,
    ok({ policies: [livePolicy({ conditions: [{ condition: 'any-client' }] })] }),
  ])
  try {
    const result = await driftDetect(driftContext([item('fapi', FAPI_POLICY)]))
    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['fapi-clients.conditions'],
    )
  } finally {
    changedCondition.restore()
  }
})

test('client-policies driftDetect asserts nothing when the list cannot be read', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('fapi', FAPI_POLICY)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('client-policies driftDetect makes no call at all when nothing is declared', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([]))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('client-policies', healthCheck)
describeGetStatusContract('client-policies', getStatus, 'keycloak-client-policies')
