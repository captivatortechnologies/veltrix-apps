// ============================================================================
// driftDetect for Entra group (directory) settings, against a fake Microsoft
// Graph.
//
// These settings are the tenant-wide guest and group-creation rules, so a value
// flipped in the portal is exactly the kind of change this handler exists to
// catch. Values are compared as an ORDER-INSENSITIVE name -> value map, because
// Graph returns the array in no particular order — a reordered array is not
// drift, a changed value is.
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

const COLLECTION = /\/v1\.0\/groupSettings$/

const TEMPLATE = '62375ab9-6b52-47ed-826b-58e47e0e304b'

const DECLARED = [
  { name: 'AllowToAddGuests', value: 'false' },
  { name: 'EnableGroupCreation', value: 'false' },
]

function settingItem(values: unknown[] = DECLARED, templateId = TEMPLATE) {
  return item('Group.Unified', { templateId, values: JSON.stringify(values) })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([settingItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: COLLECTION, method: 'GET', respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await driftDetect(driftContext([settingItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live values match, in whatever order Graph returns them', async () => {
  const { calls, restore } = routeFetch([
    {
      url: COLLECTION,
      method: 'GET',
      respond: collection([
        {
          id: 'gs-1',
          templateId: TEMPLATE,
          // Same pairs, opposite order.
          values: [
            { name: 'EnableGroupCreation', value: 'false' },
            { name: 'AllowToAddGuests', value: 'false' },
          ],
        },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([settingItem()]))

    assert.deepEqual(result.diffs, [], 'array order carries no meaning in a group setting')
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a settings object deleted from the tenant is critical drift', async () => {
  const { restore } = routeFetch([{ url: COLLECTION, method: 'GET', respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([settingItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: TEMPLATE, expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('guests re-enabled in the portal surfaces as a values diff', async () => {
  const { restore } = routeFetch([
    {
      url: COLLECTION,
      method: 'GET',
      respond: collection([
        {
          id: 'gs-1',
          templateId: TEMPLATE,
          values: [
            { name: 'AllowToAddGuests', value: 'true' },
            { name: 'EnableGroupCreation', value: 'false' },
          ],
        },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([settingItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: `${TEMPLATE}.values`,
        expected: '{"AllowToAddGuests":"false","EnableGroupCreation":"false"}',
        actual: '{"AllowToAddGuests":"true","EnableGroupCreation":"false"}',
        severity: 'warning',
      },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted — they must not carry the token')
  } finally {
    restore()
  }
})

test('a declared setting missing from the live values is drift, not an implicit default', async () => {
  const { restore } = routeFetch([
    {
      url: COLLECTION,
      method: 'GET',
      respond: collection([
        { id: 'gs-1', templateId: TEMPLATE, values: [{ name: 'AllowToAddGuests', value: 'false' }] },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([settingItem()]))

    assert.deepEqual(result.diffs, [
      {
        field: `${TEMPLATE}.values`,
        expected: '{"AllowToAddGuests":"false","EnableGroupCreation":"false"}',
        actual: '{"AllowToAddGuests":"false"}',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a live settings object for another template does not satisfy the declared one', async () => {
  const { restore } = routeFetch([
    {
      url: COLLECTION,
      method: 'GET',
      respond: collection([
        { id: 'gs-other', templateId: '08d542b9-071f-4e16-94b0-74abb372e3d9', values: DECLARED },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([settingItem()]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].actual, 'absent', 'settings are matched by templateId, never by shape')
  } finally {
    restore()
  }
})
