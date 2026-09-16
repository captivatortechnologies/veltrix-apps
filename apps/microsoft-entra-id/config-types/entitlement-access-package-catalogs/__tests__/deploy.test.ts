// ============================================================================
// deploy for Entra entitlement-management access package CATALOGS, driven end
// to end against a fake Microsoft Graph.
//
// A catalog is the delegation boundary entitlement management hangs off: its
// `state` decides whether the packages inside it can be requested at all, and
// `isExternallyVisible` decides whether users OUTSIDE the directory can request
// them. Both are single booleans/enums on the wire, so the assertions below are
// about the exact bytes sent, not just that a request happened.
//
// The other rule this handler owns is that Microsoft's own service-default
// catalog (catalogType "serviceDefault", e.g. "General") is never modified.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
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
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const BASE = '/identityGovernance/entitlementManagement/catalogs'

/** A live catalog matching the canvas item below, except where drifted. */
function liveCatalog(over: Record<string, unknown> = {}) {
  return {
    id: 'cat-1',
    displayName: 'Sales',
    description: 'Old description',
    state: 'unpublished',
    isExternallyVisible: true,
    catalogType: 'userManaged',
    ...over,
  }
}

function catalogItem(fields: Record<string, unknown> = {}, id?: string) {
  return item(
    'Sales',
    { name: 'Sales', description: 'Sales entitlements', state: 'published', isExternallyVisible: false, ...fields },
    id,
  )
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([catalogItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([catalogItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed catalog listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(deployContext([catalogItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list catalogs/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(writeCalls(calls).length, 0, 'a deploy that cannot see the live catalogs must not write')
  } finally {
    restore()
  }
})

test('deploy authenticates first, then creates a catalog closed to external users', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'cat-new' })])
  try {
    const result = await deploy(deployContext([catalogItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const write = graphCalls.find((c) => c.method === 'POST')
    assert.ok(write, 'expected a POST creating the catalog')
    assert.ok(write.url.endsWith(BASE))

    // isExternallyVisible:true would open every package in this catalog to
    // users outside the directory — it is sent exactly as the canvas declared.
    assert.deepEqual(bodyOf(write), {
      displayName: 'Sales',
      description: 'Sales entitlements',
      state: 'published',
      isExternallyVisible: false,
    })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: undefined, name: 'Sales', existed: false, id: 'cat-new' }])
    assert.equal(leaksSecret(result), false, 'the token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('deploy sends isExternallyVisible true only when the canvas explicitly asks for it', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'cat-new' })])
  try {
    await deploy(deployContext([catalogItem({ isExternallyVisible: true })]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.equal(body?.isExternallyVisible, true)
  } finally {
    restore()
  }
})

test('deploy updates a catalog that already exists and records its LIVE prior state', async () => {
  const live = liveCatalog()
  const { calls, restore } = recordFetch([TOKEN, collection([live]), ok({})])
  try {
    const result = await deploy(deployContext([catalogItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing catalog is updated, not duplicated')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`${BASE}/cat-1`))
    assert.deepEqual(bodyOf(writes[0]), {
      displayName: 'Sales',
      description: 'Sales entitlements',
      state: 'published',
      isExternallyVisible: false,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'cat-1')
    // The recorded prior is the LIVE object read off Graph — including the
    // external visibility the tenant actually had — not the desired canvas
    // values, which is what rollback needs to put back.
    assert.deepEqual(entries[0].prior, {
      displayName: 'Sales',
      description: 'Old description',
      state: 'unpublished',
      isExternallyVisible: true,
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(writes[0]))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a built-in service-default catalog is refused, not silently overwritten', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    collection([liveCatalog({ id: 'cat-general', displayName: 'General', catalogType: 'serviceDefault' })]),
  ])
  try {
    const result = await deploy(deployContext([catalogItem({ name: 'General' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /built-in service-managed catalog/)
    assert.equal(writeCalls(calls).length, 0, 'Microsoft-managed catalogs must never be patched')
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    graphError(400, 'A catalog with this display name already exists.', 'BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([catalogItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a catalog it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired catalog', existed: false, id: 'cat-old' },
            { name: 'Pre-existing catalog', existed: true, id: 'cat-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only the catalog this app created may be deleted')
    assert.ok(deletes[0].url.endsWith(`${BASE}/cat-old`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a catalog re-declared under the same name is updated, never deleted and recreated', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveCatalog()]), ok({})])
  try {
    const result = await deploy(
      deployContext([catalogItem()], {
        priorRollbackData: { entries: [{ name: 'Sales', existed: false, id: 'cat-1' }] },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH', 'deleting it would destroy every package inside it')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
