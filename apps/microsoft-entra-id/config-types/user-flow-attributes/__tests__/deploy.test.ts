// ============================================================================
// deploy for custom user-flow attributes, against a fake Graph.
//
// These are the extra fields a self-service sign-up flow collects from an
// external user. Two rules carry the risk here: a BUILT-IN attribute is
// read-only and must never be written to even when a canvas item shares its
// display name, and dataType is immutable once an attribute exists — sending it
// on an update has Graph reject the whole request.
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
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const BASE = '/identity/userFlowAttributes'
const CUSTOM_ID = 'extension_8a2b1c_shoeSize'

function attributeItem(fields: Record<string, unknown> = {}) {
  return item('Shoe size', {
    name: 'Shoe size',
    dataType: 'string',
    description: 'The size of the shoe',
    ...fields,
  })
}

function liveCustom(over: Record<string, unknown> = {}) {
  return {
    id: CUSTOM_ID,
    displayName: 'Shoe size',
    dataType: 'string',
    userFlowAttributeType: 'custom',
    description: 'Whatever the portal says today',
    ...over,
  }
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([attributeItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([attributeItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed attribute listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await deploy(deployContext([attributeItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list user flow attributes/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live attributes must not create a duplicate',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates an attribute that does not exist', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: CUSTOM_ID })])
  try {
    const result = await deploy(deployContext([attributeItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls[0].method, 'GET')

    const post = graphCalls[1]
    assert.equal(post.method, 'POST')
    assert.ok(post.url.endsWith(BASE))
    assert.deepEqual(bodyOf(post), {
      displayName: 'Shoe size',
      // dataType is settable only at creation.
      dataType: 'string',
      description: 'The size of the shoe',
    })
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('an attribute created with no description sends an empty one, never undefined', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: CUSTOM_ID })])
  try {
    await deploy(deployContext([attributeItem({ description: '' })]))

    assert.equal(bodyOf(writeCalls(calls)[0])?.description, '')
  } finally {
    restore()
  }
})

test('a newly created attribute is recorded with the id Graph assigned it', async () => {
  const { restore } = recordFetch([TOKEN, collection([]), created({ id: CUSTOM_ID })])
  try {
    const result = await deploy(deployContext([attributeItem()]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: undefined, name: 'Shoe size', existed: false, id: CUSTOM_ID }])
  } finally {
    restore()
  }
})

test('deploy updates an existing custom attribute with its description alone', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveCustom()]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([attributeItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing attribute is patched, never duplicated')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`${BASE}/${CUSTOM_ID}`))
    assert.deepEqual(
      bodyOf(writes[0]),
      { description: 'The size of the shoe' },
      'dataType is immutable — sending it would have Graph reject the update',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy records the LIVE prior description, not the canvas one', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveCustom()]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([attributeItem()]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, CUSTOM_ID)
    assert.deepEqual(entries[0].prior, { description: 'Whatever the portal says today' })
    assert.notDeepEqual(entries[0].prior, bodyOf(writeCalls(calls)[0]))
  } finally {
    restore()
  }
})

test('a live attribute with a null description is recorded as an empty prior', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveCustom({ description: null })]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([attributeItem()]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries[0].prior, { description: '' })
  } finally {
    restore()
  }
})

test('a BUILT-IN attribute of the same name is never written to', async () => {
  // Built-ins (city, givenName, ...) are read-only. A canvas item that happens to
  // share a built-in's display name must create its own custom attribute rather
  // than patch the directory's.
  const builtIn = {
    id: 'city',
    displayName: 'Shoe size',
    dataType: 'string',
    userFlowAttributeType: 'builtIn',
    description: 'A built-in attribute',
  }
  const { calls, restore } = recordFetch([TOKEN, collection([builtIn]), created({ id: CUSTOM_ID })])
  try {
    const result = await deploy(deployContext([attributeItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'POST', 'a built-in must not be patched')
    assert.equal(writes[0].url.includes('/city'), false, 'nothing may address the built-in by id')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an attribute is matched by display name case-insensitively', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveCustom({ displayName: 'SHOE SIZE' })]), NO_CONTENT])
  try {
    await deploy(deployContext([attributeItem()]))

    assert.equal(writeCalls(calls)[0].method, 'PATCH', 'a case difference must not create a second attribute')
  } finally {
    restore()
  }
})

test('a renamed attribute is found by the id the previous deploy recorded', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    collection([liveCustom({ displayName: 'Shoe size (renamed)' })]),
    NO_CONTENT,
  ])
  try {
    await deploy(
      deployContext([attributeItem()], {
        priorRollbackData: { entries: [{ name: 'Shoe size', existed: true, id: CUSTOM_ID }] },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`${BASE}/${CUSTOM_ID}`))
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    graphError(400, 'An attribute with the same name already exists.', 'Request_BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([attributeItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some user flow attributes failed/)
    assert.match(String(result.message), /already exists/)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes an attribute it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired', existed: false, id: 'extension_8a2b1c_retired' },
            { name: 'Pre-existing', existed: true, id: 'extension_8a2b1c_keep', prior: { description: '' } },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'an attribute that pre-dated this app must survive the reconcile')
    assert.ok(deletes[0].url.endsWith(`${BASE}/extension_8a2b1c_retired`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an attribute still declared is not deleted by the reconcile', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveCustom()]), NO_CONTENT])
  try {
    await deploy(
      deployContext([attributeItem()], {
        priorRollbackData: { entries: [{ name: 'Shoe size', existed: false, id: CUSTOM_ID }] },
      }),
    )

    assert.equal(writeCalls(calls).filter((c) => c.method === 'DELETE').length, 0)
  } finally {
    restore()
  }
})

test('an item with no name at all is skipped rather than written', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await deploy(deployContext([{ name: '', fields: { dataType: 'string' } }]))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(vendorCalls(calls).length, 1)
  } finally {
    restore()
  }
})
