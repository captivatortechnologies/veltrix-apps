// ============================================================================
// driftDetect for Entra security groups, against a fake Microsoft Graph.
//
// Membership drift is access drift. The asymmetry the handler encodes is worth
// pinning down: a DECLARED member missing from the live group is drift, while an
// EXTRA live member is not — that mirrors the deploy rule that this app never
// removes a reference it did not add.
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

const LIST = /\/groups\?\$select=id,displayName,description/
const GROUP_MAP = /\/groups\?\$select=id,displayName$/
const MEMBERS = /\/groups\/[^/]+\/members/
const OWNERS = /\/groups\/[^/]+\/owners/

function liveGroup(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    displayName: 'Engineering',
    description: 'Engineers',
    mailNickname: 'Engineering',
    mailEnabled: false,
    securityEnabled: true,
    groupTypes: [],
    ...over,
  }
}

function groupItem(fields: Record<string, unknown> = {}) {
  return item('Engineering', { name: 'Engineering', description: 'Engineers', ...fields })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([groupItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: graphError(403, 'Insufficient privileges.') }])
  try {
    const result = await driftDetect(driftContext([groupItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live group matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveGroup()]) },
    { url: OWNERS, respond: collection([]) },
    { url: MEMBERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([groupItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted group is critical drift', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([groupItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs[0], {
      field: 'Engineering',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
  } finally {
    restore()
  }
})

test('a description edited in the portal surfaces as a diff', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveGroup({ description: 'Edited in the portal' })]) },
    { url: OWNERS, respond: collection([]) },
    { url: MEMBERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([groupItem()]))

    const diff = result.diffs.find((d) => d.field === 'Engineering.description')
    assert.ok(diff)
    assert.equal(diff.expected, 'Engineers')
    assert.equal(diff.actual, 'Edited in the portal')
  } finally {
    restore()
  }
})

test('a declared member removed from the group is drift; an extra live member is not', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveGroup()]) },
    { url: GROUP_MAP, respond: collection([]) },
    { url: /\/users\?/, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace' }]) },
    { url: OWNERS, respond: collection([]) },
    // Someone else is in the group, but the declared member is gone.
    { url: MEMBERS, respond: collection([{ id: 'u-someone-else' }]) },
  ])
  try {
    const drifted = await driftDetect(driftContext([groupItem({ members: ['Ada Lovelace'] })]))

    const diff = drifted.diffs.find((d) => d.field === 'Engineering.members')
    assert.ok(diff, 'a declared member missing from the live group is drift')
    assert.equal(diff.severity, 'warning')
    assert.equal(leaksSecret(drifted), false, 'drift records are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('an extra live member alone is not reported as drift', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveGroup()]) },
    { url: GROUP_MAP, respond: collection([]) },
    { url: /\/users\?/, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace' }]) },
    { url: OWNERS, respond: collection([]) },
    { url: MEMBERS, respond: collection([{ id: 'u-1' }, { id: 'u-extra' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([groupItem({ members: ['Ada Lovelace'] })]))

    assert.deepEqual(result.diffs, [], 'this app never removes what it did not add, so extras are not its drift')
  } finally {
    restore()
  }
})

test('a member name that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveGroup()]) },
    { url: OWNERS, respond: collection([]) },
    { url: MEMBERS, respond: collection([]) },
  ])
  try {
    const result = await driftDetect(driftContext([groupItem({ members: ['Ghost User'] })]))

    const diff = result.diffs.find((d) => d.field === 'Engineering.members')
    assert.ok(diff)
    assert.equal(diff.severity, 'critical')
    assert.match(String(diff.actual), /Ghost User/)
  } finally {
    restore()
  }
})
