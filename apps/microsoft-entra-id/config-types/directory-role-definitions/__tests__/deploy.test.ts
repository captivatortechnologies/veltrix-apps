// ============================================================================
// deploy for Entra custom directory role definitions, against a fake Microsoft
// Graph.
//
// A role definition is a permission grant waiting to be assigned, so the
// assertions here are about what the handler refuses to do as much as what it
// does: never touch a BUILT-IN role that happens to share the name, never
// create a role whose enabled state was not the one declared, and never
// overwrite a live role without first recording the actions it used to carry —
// rollback is the only thing standing between a bad PATCH and a permanently
// widened role.
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
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const BASE = '/roleManagement/directory/roleDefinitions'
const READ_APPS = 'microsoft.directory/applications/basic/read'
const READ_GROUPS = 'microsoft.directory/groups/basic/read'

/** A live CUSTOM role, its actions split across two rolePermissions entries. */
function liveRole(over: Record<string, unknown> = {}) {
  return {
    id: 'rd-1',
    displayName: 'App Reader',
    description: 'Reads application registrations',
    isBuiltIn: false,
    isEnabled: true,
    rolePermissions: [
      { allowedResourceActions: [READ_APPS] },
      { allowedResourceActions: [READ_GROUPS] },
    ],
    ...over,
  }
}

function roleItem(fields: Record<string, unknown> = {}) {
  return item('App Reader', { name: 'App Reader', allowedResourceActions: READ_APPS, ...fields })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([roleItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call, not half way through.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([roleItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed role listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(deployContext([roleItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list role definitions/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live roles would create a duplicate of every one of them',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates a role carrying exactly the declared actions', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'rd-new' })])
  try {
    const result = await deploy(
      deployContext([
        roleItem({
          description: 'Reads application registrations',
          allowedResourceActions: `${READ_APPS}\n${READ_GROUPS}`,
        }),
      ]),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls[0].method, 'GET', 'the live roles are listed before anything is written')

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'POST')
    assert.ok(writes[0].url.endsWith(BASE))
    assert.deepEqual(bodyOf(writes[0]), {
      displayName: 'App Reader',
      description: 'Reads application registrations',
      isEnabled: true,
      // A single rolePermissions entry holding every declared action — an extra
      // action slipped in here is an extra permission for everyone assigned.
      rolePermissions: [{ allowedResourceActions: [READ_APPS, READ_GROUPS] }],
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: undefined, name: 'App Reader', existed: false, id: 'rd-new' }])
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('deploy sends isEnabled false when the canvas disables the role', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'rd-new' })])
  try {
    await deploy(deployContext([roleItem({ isEnabled: false })]))

    // A role created enabled when the canvas said otherwise is assignable the
    // moment it lands.
    assert.equal(bodyOf(writeCalls(calls)[0])?.isEnabled, false)
  } finally {
    restore()
  }
})

test('deploy updates an existing custom role and records its LIVE prior actions', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveRole()]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([roleItem({ description: 'Narrowed', allowedResourceActions: READ_APPS })]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH', 'an existing role is updated, not duplicated')
    assert.ok(writes[0].url.endsWith(`${BASE}/rd-1`))
    assert.deepEqual(bodyOf(writes[0]), {
      displayName: 'App Reader',
      description: 'Narrowed',
      isEnabled: true,
      rolePermissions: [{ allowedResourceActions: [READ_APPS] }],
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'rd-1')
    // The prior is the tenant's own state — including the SECOND permission
    // entry this deploy is dropping, flattened into one list.
    assert.deepEqual(entries[0].prior, {
      displayName: 'App Reader',
      description: 'Reads application registrations',
      isEnabled: true,
      rolePermissions: [{ allowedResourceActions: [READ_APPS, READ_GROUPS] }],
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(writes[0]))
  } finally {
    restore()
  }
})

test('deploy refuses to modify a same-named BUILT-IN role and writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveRole({ isBuiltIn: true })])])
  try {
    const result = await deploy(deployContext([roleItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /built-in directory role with this name exists and will not be modified/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a built-in role is Microsoft-owned — rewriting its permissions is not this app\'s to do',
    )
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    graphError(400, 'Resource action microsoft.directory/ghost/read is not supported.', 'Request_BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([roleItem({ allowedResourceActions: 'microsoft.directory/ghost/read' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some role definitions failed/)
    assert.match(String(result.message), /is not supported/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a rejected update still returns the rollback entries for the items that succeeded', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([liveRole(), { ...liveRole({ id: 'rd-2', displayName: 'Group Reader' }) }]),
    NO_CONTENT,
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(
      deployContext([roleItem(), item('Group Reader', { name: 'Group Reader', allowedResourceActions: READ_GROUPS })]),
    )

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the role that WAS rewritten must still be rollback-able')
    assert.equal(entries[0].id, 'rd-1')
  } finally {
    restore()
  }
})

test('deploy deletes a role it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired Role', existed: false, id: 'rd-old' },
            { name: 'Pre-existing Role', existed: true, id: 'rd-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only a role this app created may be deleted')
    assert.ok(deletes[0].url.endsWith(`${BASE}/rd-old`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a role still declared on the canvas is never swept up by the reconcile', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveRole()]), NO_CONTENT])
  try {
    await deploy(
      deployContext([roleItem()], {
        priorRollbackData: { entries: [{ name: 'App Reader', existed: false, id: 'rd-1' }] },
      }),
    )

    assert.equal(
      writeCalls(calls).filter((c) => c.method === 'DELETE').length,
      0,
      'the canvas still declares this role — the reconcile must leave it alone',
    )
  } finally {
    restore()
  }
})
