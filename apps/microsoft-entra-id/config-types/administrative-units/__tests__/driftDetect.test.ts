// ============================================================================
// driftDetect for Entra administrative units, against a fake Microsoft Graph.
//
// A unit's membership IS the delegation boundary a scoped admin inherits, so
// membership drift is authorization drift. The asymmetry the handler encodes is
// worth pinning down: a DECLARED member missing from the live unit is drift,
// while an EXTRA live member is not — that mirrors the deploy rule that this
// app never removes a member it did not add.
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

const AU_LIST = /\/directory\/administrativeUnits\?\$select=id,displayName,description/
const MEMBER_LIST = /\/administrativeUnits\/[^/]+\/members\?/

const ADA = 'a1111111-1111-1111-1111-111111111111'

function nameMapRoutes(over: { users?: unknown[]; groups?: unknown[]; devices?: unknown[] } = {}) {
  return [
    { url: /\/users\?/, respond: collection(over.users ?? []) },
    { url: /\/groups\?/, respond: collection(over.groups ?? []) },
    { url: /\/devices\?/, respond: collection(over.devices ?? []) },
  ]
}

function liveUnit(over: Record<string, unknown> = {}) {
  return {
    id: 'au-1',
    displayName: 'West Region',
    description: 'Western offices',
    visibility: null,
    membershipType: null,
    ...over,
  }
}

function unitItem(fields: Record<string, unknown> = {}) {
  return item('West Region', { name: 'West Region', description: 'Western offices', ...fields })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([unitItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed unit listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: AU_LIST, respond: graphError(403, 'Insufficient privileges.') },
  ])
  try {
    const result = await driftDetect(driftContext([unitItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live unit matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: AU_LIST, respond: collection([liveUnit()]) },
    ...nameMapRoutes(),
    { url: MEMBER_LIST, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([unitItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted unit is critical drift', async () => {
  const { restore } = routeFetch([{ url: AU_LIST, respond: collection([]) }, ...nameMapRoutes()])
  try {
    const result = await driftDetect(driftContext([unitItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'West Region', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted by the platform — they must not carry the token')
  } finally {
    restore()
  }
})

test('a unit switched to HiddenMembership, and its description edited, both surface', async () => {
  const { restore } = routeFetch([
    {
      url: AU_LIST,
      respond: collection([liveUnit({ visibility: 'HiddenMembership', description: 'Edited in the portal' })]),
    },
    ...nameMapRoutes(),
    { url: MEMBER_LIST, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([unitItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.find((d) => d.field === 'West Region.description'),
      {
        field: 'West Region.description',
        expected: 'Western offices',
        actual: 'Edited in the portal',
        severity: 'warning',
      },
    )
    assert.deepEqual(
      result.diffs.find((d) => d.field === 'West Region.visibility'),
      { field: 'West Region.visibility', expected: 'public', actual: 'HiddenMembership', severity: 'warning' },
    )
  } finally {
    restore()
  }
})

test('a live visibility of null reads as public, matching what deploy sends', async () => {
  const { restore } = routeFetch([
    { url: AU_LIST, respond: collection([liveUnit({ visibility: null })]) },
    ...nameMapRoutes(),
    { url: MEMBER_LIST, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([unitItem({ visibility: 'public' })]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('a declared member removed from the unit is drift', async () => {
  const { restore } = routeFetch([
    { url: AU_LIST, respond: collection([liveUnit()]) },
    ...nameMapRoutes({ users: [{ id: ADA, displayName: 'Ada Lovelace' }] }),
    // Somebody else is in the unit, but the declared member is gone.
    { url: MEMBER_LIST, respond: collection([{ id: 'u-someone-else' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([unitItem({ members: ['Ada Lovelace'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'West Region.members',
        expected: `["${ADA}"]`,
        actual: '["u-someone-else"]',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('an extra live member alone is not reported as drift', async () => {
  const { restore } = routeFetch([
    { url: AU_LIST, respond: collection([liveUnit()]) },
    ...nameMapRoutes({ users: [{ id: ADA, displayName: 'Ada Lovelace' }] }),
    { url: MEMBER_LIST, respond: collection([{ id: ADA }, { id: 'u-extra' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([unitItem({ members: ['Ada Lovelace'] })]))

    assert.deepEqual(result.diffs, [], 'this app never removes what it did not add, so extras are not its drift')
  } finally {
    restore()
  }
})

test('a member name that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: AU_LIST, respond: collection([liveUnit()]) },
    ...nameMapRoutes(),
    { url: MEMBER_LIST, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([unitItem({ members: ['Ghost User'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'West Region.members',
        expected: 'resolvable',
        actual: 'unknown member(s): Ghost User',
        severity: 'critical',
      },
    ])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a failed membership read is not reported as membership drift', async () => {
  const { calls, restore } = routeFetch([
    { url: MEMBER_LIST, respond: graphError(403, 'Insufficient privileges.') },
    { url: AU_LIST, respond: collection([liveUnit()]) },
    ...nameMapRoutes({ users: [{ id: ADA, displayName: 'Ada Lovelace' }] }),
  ])
  try {
    const result = await driftDetect(driftContext([unitItem({ members: ['Ada Lovelace'] })]))

    assert.deepEqual(result.diffs, [], 'a membership that could not be read is unknown, not drifted')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})
