// ============================================================================
// driftDetect for Entra custom security attribute sets, against a fake
// Microsoft Graph.
//
// Only two fields on a set are mutable, and one of them is a limit:
// `maxAttributesPerSet` raised out of band lets more attributes into the set
// than the canvas budgeted for, and a null there means NO limit — so the diff
// has to distinguish "null" from a number rather than treating an absent value
// as a match.
//
// Sets are matched on their permanent, caller-supplied `id`, case-insensitively.
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

const LIST = /\/directory\/attributeSets\?\$select=/

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

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([setItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await driftDetect(driftContext([setItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live set matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: collection([liveSet()]) }])
  try {
    const result = await driftDetect(driftContext([setItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a set missing from the directory is critical drift', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([setItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Engineering', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('a reworded description and a raised attribute cap are both diffs', async () => {
  const { restore } = routeFetch([
    {
      url: LIST,
      respond: collection([liveSet({ description: 'Reworded in the portal', maxAttributesPerSet: 100 })]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([setItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: 'Engineering.description',
        expected: 'Engineering attributes',
        actual: 'Reworded in the portal',
        severity: 'warning',
      },
      {
        field: 'Engineering.maxAttributesPerSet',
        expected: '25',
        actual: '100',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a cap removed entirely reads as null, not as a match', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([{ id: 'Engineering', description: 'Engineering attributes' }]) }])
  try {
    const result = await driftDetect(driftContext([setItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: 'Engineering.maxAttributesPerSet',
        expected: '25',
        actual: 'null',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a declared "no limit" matches a live set with no cap', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([{ id: 'Engineering', description: 'Engineering attributes' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([setItem({ maxAttributesPerSet: '' })]))

    assert.deepEqual(result.diffs, [], 'blank and absent both mean "no limit"')
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('a live set whose id differs only in case is the same set', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([liveSet({ id: 'ENGINEERING' })]) }])
  try {
    const result = await driftDetect(driftContext([setItem()]))

    assert.deepEqual(result.diffs, [], 'an id casing difference must not read as a missing set')
  } finally {
    restore()
  }
})
