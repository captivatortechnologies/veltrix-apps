// ============================================================================
// driftDetect for Entra custom security attribute definitions, against a fake
// Microsoft Graph.
//
// Only the three MUTABLE fields can drift — status, usePreDefinedValuesOnly and
// description — so those are what this compares. `status` is the one with
// teeth: a definition deprecated out of band stops accepting new assignments,
// and a definition re-activated out of band starts accepting them again.
//
// Live definitions are matched on the composite `{attributeSet}_{name}` id,
// case-insensitively, so an attribute of the same name in a different set reads
// as absent rather than as a match.
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

const LIST = /\/directory\/customSecurityAttributeDefinitions\?\$select=/

const ID = 'Engineering_Sensitivity'

function liveDefinition(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    status: 'Available',
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
    usePreDefinedValuesOnly: true,
    description: 'Data sensitivity tier',
    ...fields,
  })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([definitionItem()], { credential: null }))

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
    const result = await driftDetect(driftContext([definitionItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live definition matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([{ url: LIST, respond: collection([liveDefinition()]) }])
  try {
    const result = await driftDetect(driftContext([definitionItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a definition missing from the directory is critical drift', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([definitionItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [{ field: ID, expected: 'present', actual: 'absent', severity: 'critical' }])
  } finally {
    restore()
  }
})

test('a definition deprecated out of band surfaces as a status diff', async () => {
  const { restore } = routeFetch([{ url: LIST, respond: collection([liveDefinition({ status: 'Deprecated' })]) }])
  try {
    const result = await driftDetect(driftContext([definitionItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: `${ID}.status`, expected: 'Available', actual: 'Deprecated', severity: 'warning' },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('free-text values allowed out of band, and a reworded description, are both diffs', async () => {
  const { restore } = routeFetch([
    {
      url: LIST,
      respond: collection([liveDefinition({ usePreDefinedValuesOnly: false, description: 'Reworded in the portal' })]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([definitionItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: `${ID}.usePreDefinedValuesOnly`,
        expected: 'true',
        actual: 'false',
        severity: 'warning',
      },
      {
        field: `${ID}.description`,
        expected: 'Data sensitivity tier',
        actual: 'Reworded in the portal',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a live definition missing status or description falls back to the documented defaults', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([{ id: ID, usePreDefinedValuesOnly: true }]) },
  ])
  try {
    // status absent reads as Available and description absent reads as '', so a
    // canvas declaring exactly that sees no drift rather than a phantom one.
    const result = await driftDetect(driftContext([definitionItem({ description: '' })]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('the same attribute name in a different set does not satisfy the declared definition', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([liveDefinition({ id: 'Finance_Sensitivity' })]) },
  ])
  try {
    const result = await driftDetect(driftContext([definitionItem()]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].actual, 'absent', 'identity is {attributeSet}_{name}, not the name alone')
  } finally {
    restore()
  }
})
