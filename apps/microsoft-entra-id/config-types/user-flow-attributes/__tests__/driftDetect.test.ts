// ============================================================================
// driftDetect for custom user-flow attributes, against a fake Graph.
//
// The comparison is deliberately narrow — display name to find it, description
// to compare — but the matching rule matters: only CUSTOM attributes count, so a
// built-in that happens to share the declared name does not make a deleted
// custom attribute look present.
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

const ATTRIBUTES = /\/identity\/userFlowAttributes/
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
    description: 'The size of the shoe',
    ...over,
  }
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([attributeItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect reports nothing when the tenant id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([attributeItem()], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([{ url: ATTRIBUTES, respond: graphError(403, 'Insufficient privileges.') }])
  try {
    const result = await driftDetect(driftContext([attributeItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [], 'a listing that failed is not evidence the attribute is gone')
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live attribute matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([{ url: ATTRIBUTES, respond: collection([liveCustom()]) }])
  try {
    const result = await driftDetect(driftContext([attributeItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('an attribute deleted in the portal is critical drift', async () => {
  const { restore } = routeFetch([{ url: ATTRIBUTES, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([attributeItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Shoe size', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a built-in of the same name does not stand in for the deleted custom attribute', async () => {
  const { restore } = routeFetch([
    { url: ATTRIBUTES, respond: collection([liveCustom({ id: 'city', userFlowAttributeType: 'builtIn' })]) },
  ])
  try {
    const result = await driftDetect(driftContext([attributeItem()]))

    assert.deepEqual(result.diffs, [
      { field: 'Shoe size', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a description edited in the portal surfaces as a diff', async () => {
  const { restore } = routeFetch([
    { url: ATTRIBUTES, respond: collection([liveCustom({ description: 'Edited in the portal' })]) },
  ])
  try {
    const result = await driftDetect(driftContext([attributeItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Shoe size.description',
        expected: 'The size of the shoe',
        actual: 'Edited in the portal',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a description cleared live reads as empty, not as a match', async () => {
  const { restore } = routeFetch([{ url: ATTRIBUTES, respond: collection([liveCustom({ description: null })]) }])
  try {
    const result = await driftDetect(driftContext([attributeItem()]))

    const diff = result.diffs.find((d) => d.field === 'Shoe size.description')
    assert.ok(diff)
    assert.equal(diff.actual, '')
    assert.equal(diff.expected, 'The size of the shoe')
  } finally {
    restore()
  }
})

test('an attribute declared with no description matches a live one with none', async () => {
  const { restore } = routeFetch([{ url: ATTRIBUTES, respond: collection([liveCustom({ description: null })]) }])
  try {
    const result = await driftDetect(driftContext([attributeItem({ description: '' })]))

    assert.deepEqual(result.diffs, [], 'an unset description and an empty one are the same thing')
  } finally {
    restore()
  }
})

test('an attribute listed under a differently-cased name is still matched', async () => {
  const { restore } = routeFetch([{ url: ATTRIBUTES, respond: collection([liveCustom({ displayName: 'SHOE SIZE' })]) }])
  try {
    const result = await driftDetect(driftContext([attributeItem()]))

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('drift compares the DEPLOYED canvas, not an unsaved edit', async () => {
  const { restore } = routeFetch([{ url: ATTRIBUTES, respond: collection([liveCustom()]) }])
  try {
    const result = await driftDetect(
      driftContext([attributeItem({ description: 'edited but never deployed' })], {
        deployedItems: [attributeItem()],
      }),
    )

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
