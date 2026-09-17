// ============================================================================
// driftDetect for Entra custom directory role definitions.
//
// The drift that matters is a permission list edited in the portal — a role
// that quietly gained `microsoft.directory/users/password/update` is a
// privilege escalation nobody approved. Actions compare as SETS (Graph returns
// them across several rolePermissions entries in no guaranteed order), so a
// reordering must not be reported while a genuine addition must.
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

const LIST = /\/roleDefinitions\?\$select=id,displayName,description/
const READ_APPS = 'microsoft.directory/applications/basic/read'
const READ_GROUPS = 'microsoft.directory/groups/basic/read'
const RESET_PASSWORDS = 'microsoft.directory/users/password/update'

function liveRole(over: Record<string, unknown> = {}) {
  return {
    id: 'rd-1',
    displayName: 'App Reader',
    description: 'Reads application registrations',
    isBuiltIn: false,
    isEnabled: true,
    rolePermissions: [{ allowedResourceActions: [READ_APPS, READ_GROUPS] }],
    ...over,
  }
}

function roleItem(fields: Record<string, unknown> = {}) {
  return item('App Reader', {
    name: 'App Reader',
    description: 'Reads application registrations',
    allowedResourceActions: `${READ_APPS}\n${READ_GROUPS}`,
    ...fields,
  })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([roleItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: graphError(403, 'Insufficient privileges.') }])
  try {
    const result = await driftDetect(driftContext([roleItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live role matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: collection([liveRole()]) }])
  try {
    const result = await driftDetect(driftContext([roleItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a deleted role is critical drift', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([roleItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'App Reader', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted by the platform — they must not carry the token')
  } finally {
    restore()
  }
})

test('a permission added in the portal surfaces as an allowedResourceActions diff', async () => {
  const { restore } = routeFetch([
    {
      url: LIST,
      respond: collection([
        liveRole({ rolePermissions: [{ allowedResourceActions: [READ_APPS, READ_GROUPS, RESET_PASSWORDS] }] }),
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([roleItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: 'App Reader.allowedResourceActions',
        expected: `${READ_APPS}, ${READ_GROUPS}`,
        actual: `${READ_APPS}, ${READ_GROUPS}, ${RESET_PASSWORDS}`,
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('the same actions in another order, or split across permission entries, are not drift', async () => {
  const { restore } = routeFetch([
    {
      url: LIST,
      respond: collection([
        liveRole({
          rolePermissions: [{ allowedResourceActions: [READ_GROUPS] }, { allowedResourceActions: [READ_APPS] }],
        }),
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([roleItem()]))

    assert.deepEqual(result.diffs, [], 'Graph returns these as an unordered set across entries')
  } finally {
    restore()
  }
})

test('a role disabled in the portal, and its description edited, both surface', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveRole({ isEnabled: false, description: 'Edited in the portal' })]) },
  ])
  try {
    const result = await driftDetect(driftContext([roleItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.find((d) => d.field === 'App Reader.isEnabled'),
      { field: 'App Reader.isEnabled', expected: 'true', actual: 'false', severity: 'warning' },
    )
    assert.deepEqual(
      result.diffs.find((d) => d.field === 'App Reader.description'),
      {
        field: 'App Reader.description',
        expected: 'Reads application registrations',
        actual: 'Edited in the portal',
        severity: 'warning',
      },
    )
  } finally {
    restore()
  }
})

test('a live role that omits isEnabled counts as enabled, matching Graph\'s own default', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveRole({ isEnabled: undefined, description: null })]) },
  ])
  try {
    const result = await driftDetect(driftContext([roleItem({ description: '' })]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
