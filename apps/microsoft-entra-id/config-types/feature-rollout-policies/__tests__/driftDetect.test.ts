// ============================================================================
// driftDetect for Entra feature rollout policies, against a fake Microsoft Graph.
//
// The drift that matters is the rollout getting BIGGER or smaller than the
// canvas says: `isAppliedToOrganization` flipping on out of band takes a pilot
// tenant-wide, and a declared group falling out of appliesTo silently drops
// people from it. An EXTRA live group is deliberately not drift — it mirrors
// the deploy rule that this app never removes a reference it did not add.
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

const LIST = /\/policies\/featureRolloutPolicies\?\$select=/
const APPLIES_TO_LIST = /\/policies\/featureRolloutPolicies\/[^/]+\/appliesTo\?\$select=id$/
const GROUP_MAP = /\/groups\?\$select=id,displayName/

function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    displayName: 'Seamless SSO Rollout',
    feature: 'seamlessSso',
    isEnabled: true,
    isAppliedToOrganization: false,
    ...over,
  }
}

function rolloutItem(fields: Record<string, unknown> = {}) {
  return item('Seamless SSO Rollout', {
    name: 'Seamless SSO Rollout',
    feature: 'seamlessSso',
    isEnabled: true,
    ...fields,
  })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([rolloutItem()], { credential: null }))

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
    const result = await driftDetect(driftContext([rolloutItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live rollout matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO_LIST, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([rolloutItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted rollout is critical drift', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([rolloutItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs[0], {
      field: 'Seamless SSO Rollout',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
  } finally {
    restore()
  }
})

test('a rollout switched off, and widened tenant-wide, surfaces as two field diffs', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ isEnabled: false, isAppliedToOrganization: true })]) },
    { url: APPLIES_TO_LIST, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([rolloutItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: 'Seamless SSO Rollout.isEnabled',
        expected: 'true',
        actual: 'false',
        severity: 'warning',
      },
      {
        field: 'Seamless SSO Rollout.isAppliedToOrganization',
        expected: 'false',
        actual: 'true',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a rollout pointed at a different feature is drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy({ feature: 'passwordHashSync' })]) },
    { url: APPLIES_TO_LIST, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([rolloutItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Seamless SSO Rollout.feature',
        expected: 'seamlessSso',
        actual: 'passwordHashSync',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a declared group dropped from the rollout is drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO_LIST, respond: collection([{ id: 'g-other' }]) },
    { url: GROUP_MAP, respond: collection([{ id: 'g-1', displayName: 'SSO Pilot' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([rolloutItem({ appliesTo: ['SSO Pilot'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Seamless SSO Rollout.appliesTo',
        expected: '["g-1"]',
        actual: '["g-other"]',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('an extra live group alone is not reported as drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: APPLIES_TO_LIST, respond: collection([{ id: 'g-1' }, { id: 'g-extra' }]) },
    { url: GROUP_MAP, respond: collection([{ id: 'g-1', displayName: 'SSO Pilot' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([rolloutItem({ appliesTo: ['SSO Pilot'] })]))

    assert.deepEqual(result.diffs, [], 'this app never removes what it did not add, so extras are not its drift')
  } finally {
    restore()
  }
})

test('a group name that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([livePolicy()]) },
    { url: GROUP_MAP, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([rolloutItem({ appliesTo: ['Ghost Group'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Seamless SSO Rollout.appliesTo',
        expected: 'resolvable',
        actual: 'unknown group(s): Ghost Group',
        severity: 'critical',
      },
    ])
  } finally {
    restore()
  }
})
