// ============================================================================
// deploy for Entra group (directory) settings, against a fake Microsoft Graph.
//
// A groupSetting object is where the tenant-wide Microsoft 365 group rules
// live: whether guests may be added to groups, whether anyone may create one,
// which classifications exist. Its logical identity is the `templateId`, NOT a
// display name, and the value payload is a flat `[{name, value}]` array — so
// the assertions here are about matching the right template and putting exactly
// the declared values on the wire.
//
// `templateId` is set at creation and belongs only in the POST body; a PATCH
// that carried it would be trying to re-point an existing settings object at a
// different template.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  ok,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

/** GET /groupSettings — the live settings listing (POST to the same path creates). */
const COLLECTION = /\/v1\.0\/groupSettings$/
const SETTING = /\/v1\.0\/groupSettings\/[^/?]+$/

/** The Group.Unified template — the tenant-wide Microsoft 365 group rules. */
const TEMPLATE = '62375ab9-6b52-47ed-826b-58e47e0e304b'
/** A second template, used to prove settings are matched by template, not by position. */
const OTHER_TEMPLATE = '08d542b9-071f-4e16-94b0-74abb372e3d9'

const GUESTS_LOCKED_DOWN = [
  { name: 'AllowToAddGuests', value: 'false' },
  { name: 'EnableGroupCreation', value: 'false' },
]
const GUESTS_ALLOWED = [
  { name: 'AllowToAddGuests', value: 'true' },
  { name: 'EnableGroupCreation', value: 'true' },
]

function settingItem(values: unknown[] = GUESTS_LOCKED_DOWN, templateId = TEMPLATE) {
  return item('Group.Unified', { templateId, values: JSON.stringify(values) })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([settingItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([settingItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed settings listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: COLLECTION, method: 'GET', respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([settingItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list group settings/)
    assert.equal(writeCalls(calls).length, 0, 'a deploy that cannot see live settings must not create one')
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates the settings object for its template', async () => {
  const { calls, restore } = routeFetch([
    { url: COLLECTION, method: 'GET', respond: collection([]) },
    { url: COLLECTION, method: 'POST', respond: created({ id: 'gs-new' }) },
  ])
  try {
    const result = await deploy(deployContext([settingItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const post = graphCalls.find((c) => c.method === 'POST')
    assert.ok(post, 'expected a POST creating the settings object')
    assert.ok(post.url.endsWith('/groupSettings'))
    assert.deepEqual(bodyOf(post), { templateId: TEMPLATE, values: GUESTS_LOCKED_DOWN })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: undefined, name: TEMPLATE, existed: false, id: 'gs-new' }])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy updates the settings object that already exists and records its LIVE prior values', async () => {
  const { calls, restore } = routeFetch([
    {
      url: COLLECTION,
      method: 'GET',
      respond: collection([{ id: 'gs-1', templateId: TEMPLATE, values: GUESTS_ALLOWED }]),
    },
    { url: SETTING, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([settingItem()]))

    const patch = writeCalls(calls).find((c) => c.method === 'PATCH')
    assert.ok(patch, 'an existing settings object is updated, not duplicated')
    assert.ok(patch.url.endsWith('/groupSettings/gs-1'))
    const body = bodyOf(patch)
    assert.deepEqual(body, { values: GUESTS_LOCKED_DOWN })
    assert.equal(body && 'templateId' in body, false, 'a PATCH must not re-point the object at another template')

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'gs-1')
    // Rollback has to put the tenant's own guest rules back, not the canvas's.
    assert.deepEqual(entries[0].prior, { values: GUESTS_ALLOWED })
    assert.notDeepEqual(entries[0].prior, body)
  } finally {
    restore()
  }
})

test('a live settings object for a different template is not adopted', async () => {
  const { calls, restore } = routeFetch([
    {
      url: COLLECTION,
      method: 'GET',
      respond: collection([{ id: 'gs-other', templateId: OTHER_TEMPLATE, values: GUESTS_ALLOWED }]),
    },
    { url: COLLECTION, method: 'POST', respond: created({ id: 'gs-new' }) },
  ])
  try {
    const result = await deploy(deployContext([settingItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'POST', 'identity is the templateId — a different template is a different object')
    assert.equal(bodyOf(writes[0])?.templateId, TEMPLATE)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy matches a live template id case-insensitively rather than creating a duplicate', async () => {
  const { calls, restore } = routeFetch([
    {
      url: COLLECTION,
      method: 'GET',
      respond: collection([{ id: 'gs-1', templateId: TEMPLATE.toUpperCase(), values: GUESTS_ALLOWED }]),
    },
    { url: SETTING, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([settingItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH', 'a GUID that differs only in case is the same template')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: COLLECTION, method: 'GET', respond: collection([]) },
    {
      url: COLLECTION,
      method: 'POST',
      respond: graphError(400, 'A conflicting object with one or more of the specified property values is present.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([settingItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /conflicting object/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a settings object it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: COLLECTION, method: 'GET', respond: collection([]) },
    { url: SETTING, method: 'DELETE', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: OTHER_TEMPLATE, existed: false, id: 'gs-old' },
            { name: TEMPLATE, existed: true, id: 'gs-keep', prior: { values: GUESTS_ALLOWED } },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'a settings object that pre-existed this app must never be deleted')
    assert.ok(deletes[0].url.endsWith('/groupSettings/gs-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a settings object still declared by the canvas is not deleted by the reconcile pass', async () => {
  const { calls, restore } = routeFetch([
    {
      url: COLLECTION,
      method: 'GET',
      respond: collection([{ id: 'gs-1', templateId: TEMPLATE, values: GUESTS_ALLOWED }]),
    },
    { url: SETTING, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(
      deployContext([settingItem()], {
        priorRollbackData: { entries: [{ name: TEMPLATE, existed: false, id: 'gs-1' }] },
      }),
    )

    assert.equal(writeCalls(calls).filter((c) => c.method === 'DELETE').length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
