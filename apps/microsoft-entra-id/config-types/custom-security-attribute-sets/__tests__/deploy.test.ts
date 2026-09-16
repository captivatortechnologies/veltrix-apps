// ============================================================================
// deploy for Entra custom security attribute sets, against a fake Microsoft
// Graph.
//
// An attribute set can be neither RENAMED nor DELETED — its caller-supplied
// `id` is permanent and is the object's whole identity. That makes this the one
// config type in this app whose deploy has no reconcile-delete pass at all, so
// the assertion that matters most is a negative one: whatever the canvas stops
// declaring, no DELETE is ever issued.
//
// `id` belongs in the POST body only; a PATCH carrying it would be attempting
// the rename Graph does not allow.
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

const LIST = /\/directory\/attributeSets\?\$select=/
const CREATE = /\/v1\.0\/directory\/attributeSets$/
const SET = /\/v1\.0\/directory\/attributeSets\/[^/?]+$/

function liveSet(over: Record<string, unknown> = {}) {
  return { id: 'Engineering', description: 'Engineering attributes', maxAttributesPerSet: 25, ...over }
}

function setItem(fields: Record<string, unknown> = {}) {
  return item('Engineering', {
    id: 'Engineering',
    description: 'Engineering attributes',
    maxAttributesPerSet: 25,
    ...fields,
  })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([setItem()], { credential: null }))

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
    const result = await deploy(deployContext([setItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed attribute set listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([setItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list attribute sets/)
    assert.equal(writeCalls(calls).length, 0, 'a deploy that cannot see live sets must not create one')
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates the set with its permanent id', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'Engineering' }) },
  ])
  try {
    const result = await deploy(deployContext([setItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const post = graphCalls.find((c) => c.method === 'POST')
    assert.ok(post, 'expected a POST creating the set')
    assert.ok(post.url.endsWith('/directory/attributeSets'))
    assert.deepEqual(bodyOf(post), {
      id: 'Engineering',
      description: 'Engineering attributes',
      maxAttributesPerSet: 25,
    })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    // The id is the caller's own, not one read back from the response.
    assert.deepEqual(entries, [{ itemId: undefined, name: 'Engineering', existed: false, id: 'Engineering' }])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy updates a set that already exists and records its LIVE prior fields', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveSet({ description: 'Old wording', maxAttributesPerSet: 10 })]) },
    { url: SET, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([setItem()]))

    const patch = writeCalls(calls).find((c) => c.method === 'PATCH')
    assert.ok(patch, 'an existing set is updated, not duplicated')
    assert.ok(patch.url.endsWith('/directory/attributeSets/Engineering'))
    const body = bodyOf(patch)
    assert.deepEqual(body, { description: 'Engineering attributes', maxAttributesPerSet: 25 })
    assert.equal(body && 'id' in body, false, 'an attribute set cannot be renamed — a PATCH must not carry its id')

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    // Rollback has to restore the tenant's own cap, not the canvas's.
    assert.deepEqual(entries[0].prior, { description: 'Old wording', maxAttributesPerSet: 10 })
    assert.notDeepEqual(entries[0].prior, body)
  } finally {
    restore()
  }
})

test('a blank attribute cap is sent as null — "no limit", not zero', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'Engineering' }) },
  ])
  try {
    await deploy(deployContext([setItem({ maxAttributesPerSet: '' })]))

    const post = writeCalls(calls).find((c) => c.method === 'POST')
    assert.equal(bodyOf(post)?.maxAttributesPerSet, null)
  } finally {
    restore()
  }
})

test('a live set with no description snapshots as an empty string, not undefined', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([{ id: 'Engineering' }]) },
    { url: SET, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([setItem()]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    // A prior that JSON-round-trips cleanly is what makes rollback replayable.
    assert.deepEqual(entries[0].prior, { description: '', maxAttributesPerSet: null })
  } finally {
    restore()
  }
})

test('deploy matches a live set id case-insensitively rather than creating a duplicate', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveSet({ id: 'engineering' })]) },
    { url: SET, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([setItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith('/directory/attributeSets/engineering'), 'the LIVE id is the one addressed')
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
      respond: graphError(400, 'An attribute set with the same id already exists.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([setItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /same id already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a set this app created and no longer declares is preserved, never deleted', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: collection([liveSet({ id: 'Retired' })]) }])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [{ name: 'Retired', existed: false, id: 'Retired' }],
        },
      }),
    )

    assert.equal(
      writeCalls(calls).length,
      0,
      'attribute sets cannot be deleted, so an undeclared one is left exactly as it is',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
