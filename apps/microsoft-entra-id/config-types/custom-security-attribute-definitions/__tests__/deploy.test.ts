// ============================================================================
// deploy for Entra custom security attribute definitions, against a fake
// Microsoft Graph.
//
// Two things make this type unusual and worth pinning down on the wire:
//
//   * A definition can NEVER be deleted. "Removing" one is a status change to
//     Deprecated, so the reconcile pass must issue a PATCH and never a DELETE —
//     a delete here would be a request Graph rejects, and a silent data-loss
//     attempt if it ever stopped rejecting it.
//   * Most of the object is IMMUTABLE after creation (attributeSet, name, type,
//     isCollection, isSearchable). Those belong in the POST body only; a PATCH
//     that carried them would be trying to redefine a live attribute.
//
// The resource id is the composite `{attributeSet}_{name}`, so identity is
// asserted on that rather than on a display name.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
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

const LIST = /\/directory\/customSecurityAttributeDefinitions\?\$select=/
const CREATE = /\/v1\.0\/directory\/customSecurityAttributeDefinitions$/
const DEFINITION = /\/v1\.0\/directory\/customSecurityAttributeDefinitions\/[^/?]+$/

const ID = 'Engineering_Sensitivity'

function liveDefinition(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    attributeSet: 'Engineering',
    name: 'Sensitivity',
    type: 'String',
    status: 'Available',
    isCollection: false,
    isSearchable: true,
    usePreDefinedValuesOnly: true,
    description: 'Data sensitivity tier',
    ...over,
  }
}

function definitionItem(fields: Record<string, unknown> = {}) {
  return item('Sensitivity', {
    attributeSet: 'Engineering',
    name: 'Sensitivity',
    type: 'String',
    status: 'Available',
    isSearchable: true,
    usePreDefinedValuesOnly: true,
    description: 'Data sensitivity tier',
    ...fields,
  })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([definitionItem()], { credential: null }))

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
    const result = await deploy(deployContext([definitionItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed definition listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([definitionItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list attribute definitions/)
    assert.equal(writeCalls(calls).length, 0, 'a deploy that cannot see live definitions must not create one')
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates the definition with its immutable shape', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: ID }) },
  ])
  try {
    const result = await deploy(deployContext([definitionItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const post = graphCalls.find((c) => c.method === 'POST')
    assert.ok(post, 'expected a POST creating the definition')
    assert.ok(post.url.endsWith('/directory/customSecurityAttributeDefinitions'))
    assert.deepEqual(bodyOf(post), {
      attributeSet: 'Engineering',
      name: 'Sensitivity',
      type: 'String',
      status: 'Available',
      isCollection: false,
      isSearchable: true,
      usePreDefinedValuesOnly: true,
      description: 'Data sensitivity tier',
    })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    // The id is the composite {set}_{name}, derived locally rather than read
    // back — rollback has to be able to address it either way.
    assert.deepEqual(entries, [{ itemId: undefined, name: ID, existed: false, id: ID }])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy updates only the mutable fields of a definition that already exists', async () => {
  const { calls, restore } = routeFetch([
    {
      url: LIST,
      respond: collection([
        liveDefinition({ status: 'Deprecated', usePreDefinedValuesOnly: false, description: 'Old wording' }),
      ]),
    },
    { url: DEFINITION, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([definitionItem()]))

    const patch = writeCalls(calls).find((c) => c.method === 'PATCH')
    assert.ok(patch, 'an existing definition is updated, not duplicated')
    assert.ok(patch.url.endsWith(`/directory/customSecurityAttributeDefinitions/${ID}`))
    const body = bodyOf(patch)
    assert.deepEqual(body, {
      status: 'Available',
      usePreDefinedValuesOnly: true,
      description: 'Data sensitivity tier',
    })
    for (const immutable of ['attributeSet', 'name', 'type', 'isCollection', 'isSearchable']) {
      assert.equal(body && immutable in body, false, `${immutable} is immutable — a PATCH must not carry it`)
    }

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    // Rollback has to restore the tenant's own status/description, not the
    // canvas's — re-activating a deprecated attribute is a real change.
    assert.deepEqual(entries[0].prior, {
      status: 'Deprecated',
      usePreDefinedValuesOnly: false,
      description: 'Old wording',
    })
    assert.notDeepEqual(entries[0].prior, body)
  } finally {
    restore()
  }
})

test('the same attribute name in a different set is a different definition', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveDefinition({ id: 'Finance_Sensitivity', attributeSet: 'Finance' })]) },
    { url: CREATE, method: 'POST', respond: created({ id: ID }) },
  ])
  try {
    const result = await deploy(deployContext([definitionItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'POST', 'identity is {attributeSet}_{name}, not the name alone')
    assert.equal(bodyOf(writes[0])?.attributeSet, 'Engineering')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy matches a live definition id case-insensitively rather than creating a duplicate', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveDefinition({ id: ID.toLowerCase() })]) },
    { url: DEFINITION, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([definitionItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    {
      url: CREATE,
      method: 'POST',
      respond: graphError(400, 'The attribute set Engineering does not exist.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([definitionItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /attribute set Engineering does not exist/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a definition this app created and no longer declares is DEPRECATED, never deleted', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: DEFINITION, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Engineering_Retired', existed: false, id: 'Engineering_Retired' },
            { name: 'Engineering_PreExisting', existed: true, id: 'Engineering_PreExisting', prior: {} },
          ],
        },
      }),
    )

    assert.equal(
      writeCalls(calls).filter((c) => c.method === 'DELETE').length,
      0,
      'custom security attribute definitions cannot be deleted',
    )
    const patches = writeCalls(calls).filter((c) => c.method === 'PATCH')
    assert.equal(patches.length, 1, 'a definition that pre-existed this app must be left alone entirely')
    assert.ok(patches[0].url.endsWith('/directory/customSecurityAttributeDefinitions/Engineering_Retired'))
    assert.deepEqual(bodyOf(patches[0]), { status: 'Deprecated' })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a definition still declared by the canvas is not deprecated by the reconcile pass', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveDefinition()]) },
    { url: DEFINITION, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(
      deployContext([definitionItem()], {
        priorRollbackData: { entries: [{ name: ID, existed: false, id: ID }] },
      }),
    )

    const patches = writeCalls(calls).filter((c) => c.method === 'PATCH')
    assert.equal(patches.length, 1, 'only the declared update — no follow-up deprecation')
    assert.equal(bodyOf(patches[0])?.status, 'Available')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
