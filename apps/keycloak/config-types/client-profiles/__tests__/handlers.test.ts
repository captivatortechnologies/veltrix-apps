// =============================================================================
// Keycloak Client Profiles — deploy / rollback / healthCheck / driftDetect /
// getStatus driven end to end against the fake Keycloak.
//
// Like its sibling client-policies, `client-policies/profiles` is a realm-wide
// WHOLE-LIST singleton: one read, one write. A failed read must therefore stop
// the handler before it replaces the realm's entire profile list, and
// `globalProfiles` (Keycloak's own FAPI built-ins) must never be echoed back.
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

const ORG_BASELINE = {
  name: 'org-baseline',
  description: 'Baseline hardening for every org client',
  executors: JSON.stringify([
    { executor: 'secure-client-authenticator', configuration: { 'allowed-client-authenticators': ['client-jwt'] } },
    { executor: 'pkce-enforcer', configuration: { 'auto-configure': true } },
  ]),
}

/** Keycloak's own built-in profiles, which this config type never authors. */
const GLOBAL_PROFILES = [{ name: 'fapi-1-advanced', executors: [] }]

function liveProfile(over: Record<string, unknown> = {}) {
  return {
    name: 'org-baseline',
    description: 'Baseline hardening for every org client',
    executors: [
      { executor: 'secure-client-authenticator', configuration: { 'allowed-client-authenticators': ['client-jwt'] } },
      { executor: 'pkce-enforcer', configuration: { 'auto-configure': true } },
    ],
    ...over,
  }
}

// --- deploy -------------------------------------------------------------------

test('client-profiles deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('baseline', ORG_BASELINE)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-profiles deploy stops before writing when the current list cannot be read', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await deploy(deployContext([item('baseline', ORG_BASELINE)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /read client-policies\/profiles/)
    assert.equal(writeCalls(calls).length, 0, 'a blind whole-list write would delete every existing profile')
  } finally {
    restore()
  }
})

test('client-profiles deploy reads the current list, then writes the complete desired list', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok({ profiles: [liveProfile({ name: 'legacy' })], globalProfiles: GLOBAL_PROFILES }),
    noContent(),
  ])
  try {
    const result = await deploy(deployContext([item('baseline', ORG_BASELINE)]))

    assert.ok(isTokenCall(calls[0]))
    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /client-policies/profiles', 'PUT /client-policies/profiles'],
    )

    const body = bodyOf(vendor[1]) as { profiles: Array<Record<string, unknown>> }
    assert.equal(body.profiles.length, 1)
    assert.equal(body.profiles[0].name, 'org-baseline')
    assert.deepEqual(body.profiles[0].executors, [
      { executor: 'secure-client-authenticator', configuration: { 'allowed-client-authenticators': ['client-jwt'] } },
      { executor: 'pkce-enforcer', configuration: { 'auto-configure': true } },
    ])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('client-profiles deploy never echoes globalProfiles from the read into the write', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok({ profiles: [], globalProfiles: GLOBAL_PROFILES }), noContent()])
  try {
    await deploy(deployContext([item('baseline', ORG_BASELINE)]))

    const body = bodyOf(vendorCalls(calls)[1]) as Record<string, unknown>
    assert.deepEqual(Object.keys(body), ['profiles'])
  } finally {
    restore()
  }
})

test('client-profiles deploy preserves executor order, which changes enforcement order', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok({ profiles: [] }), noContent()])
  try {
    await deploy(deployContext([item('baseline', ORG_BASELINE)]))

    const body = bodyOf(vendorCalls(calls)[1]) as { profiles: Array<{ executors: Array<{ executor: string }> }> }
    assert.deepEqual(
      body.profiles[0].executors.map((e) => e.executor),
      ['secure-client-authenticator', 'pkce-enforcer'],
    )
  } finally {
    restore()
  }
})

test('client-profiles deploy records the exact prior list for rollback, not the desired one', async () => {
  const prior = [liveProfile({ name: 'legacy' })]
  const { restore } = recordKeycloak([TOKEN, ok({ profiles: prior, globalProfiles: GLOBAL_PROFILES }), noContent()])
  try {
    const result = await deploy(deployContext([item('baseline', ORG_BASELINE)]))

    const data = result.rollbackData as { priorProfiles: unknown[] }
    assert.deepEqual(data.priorProfiles, prior)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('client-profiles deploy fails before writing when a profile declares unparseable executors', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok({ profiles: [] })])
  try {
    const result = await deploy(deployContext([item('baseline', { ...ORG_BASELINE, executors: '{not json' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Client profile "org-baseline"/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('client-profiles deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, ok({ profiles: [] }), kcError(400, 'Unknown executor provider')])
  try {
    const result = await deploy(deployContext([item('baseline', ORG_BASELINE)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /400/)
  } finally {
    restore()
  }
})

test('client-profiles deploy drops an item with a blank name from the written list', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok({ profiles: [] }), noContent()])
  try {
    const result = await deploy(
      deployContext([item('blank', { ...ORG_BASELINE, name: '' }), item('baseline', ORG_BASELINE)]),
    )

    const body = bodyOf(vendorCalls(calls)[1]) as { profiles: Array<{ name: string }> }
    assert.deepEqual(
      body.profiles.map((p) => p.name),
      ['org-baseline'],
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('client-profiles rollback refuses when no prior list was recorded', async () => {
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

test('client-profiles rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ priorProfiles: [liveProfile()] }, { credential: null }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-profiles rollback restores the prior list verbatim with one write', async () => {
  const prior = [liveProfile({ name: 'legacy' })]
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ priorProfiles: prior }))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['PUT /client-policies/profiles'],
    )
    assert.deepEqual(bodyOf(vendor[0]), { profiles: prior })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('client-profiles rollback restores an empty prior list instead of treating it as a no-op', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ priorProfiles: [] }))

    assert.equal(result.success, true)
    assert.deepEqual(bodyOf(vendorCalls(calls)[0]), { profiles: [] })
  } finally {
    restore()
  }
})

test('client-profiles rollback reports failure rather than throwing when the write is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(rollbackContext({ priorProfiles: [liveProfile()] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('client-profiles driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('baseline', ORG_BASELINE)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-profiles driftDetect reports no drift when the live profile matches', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok({ profiles: [liveProfile()] })])
  try {
    const result = await driftDetect(driftContext([item('baseline', ORG_BASELINE)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('client-profiles driftDetect treats a declared profile missing from the realm as critical', async () => {
  const { restore } = recordKeycloak([TOKEN, ok({ profiles: [] })])
  try {
    const result = await driftDetect(driftContext([item('baseline', ORG_BASELINE)]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].field, 'org-baseline')
    assert.equal(result.diffs[0].actual, 'missing')
    assert.equal(result.diffs[0].severity, 'critical')
  } finally {
    restore()
  }
})

test('client-profiles driftDetect reports reordered executors as real drift', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    ok({
      profiles: [
        liveProfile({
          executors: [
            { executor: 'pkce-enforcer', configuration: { 'auto-configure': true } },
            {
              executor: 'secure-client-authenticator',
              configuration: { 'allowed-client-authenticators': ['client-jwt'] },
            },
          ],
        }),
      ],
    }),
  ])
  try {
    const result = await driftDetect(driftContext([item('baseline', ORG_BASELINE)]))

    // Reordering executors changes enforcement order, so it is not cosmetic.
    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['org-baseline.executors'],
    )
  } finally {
    restore()
  }
})

test('client-profiles driftDetect ignores key order inside an executor configuration', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    ok({
      profiles: [
        liveProfile({
          executors: [
            {
              configuration: { 'allowed-client-authenticators': ['client-jwt'] },
              executor: 'secure-client-authenticator',
            },
            { configuration: { 'auto-configure': true }, executor: 'pkce-enforcer' },
          ],
        }),
      ],
    }),
  ])
  try {
    const result = await driftDetect(driftContext([item('baseline', ORG_BASELINE)]))

    assert.equal(result.hasDrift, false, 'JSON key order is not a configuration change')
  } finally {
    restore()
  }
})

test('client-profiles driftDetect reports a changed description', async () => {
  const { restore } = recordKeycloak([TOKEN, ok({ profiles: [liveProfile({ description: 'Edited in console' })] })])
  try {
    const result = await driftDetect(driftContext([item('baseline', ORG_BASELINE)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['org-baseline.description'],
    )
  } finally {
    restore()
  }
})

test('client-profiles driftDetect asserts nothing when the list cannot be read', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('baseline', ORG_BASELINE)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('client-profiles', healthCheck)
describeGetStatusContract('client-profiles', getStatus, 'keycloak-client-profiles')
