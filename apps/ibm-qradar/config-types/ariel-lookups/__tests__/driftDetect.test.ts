// driftDetect for ariel-lookups.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: the live list carries the whole map, so the comparison is over
// the key→value pairs themselves — a lookup silently re-keyed in the console is
// the case this check exists to catch — and a type that no longer matches is
// critical because no redeploy can fix it.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, pathOf, recordFetch, writeCalls } from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/ariel/lookups'

const DEPARTMENTS = item(
  'department_lookup',
  {
    name: 'department_lookup',
    type: 'String',
    defaultValue: 'unknown',
    entries: 'hr=Human Resources\nfin=Finance',
  },
  'item-dept',
)

function liveLookup(over: Record<string, unknown> = {}) {
  return {
    name: 'department_lookup',
    type: 'String',
    default_value: 'unknown',
    map: { hr: 'Human Resources', fin: 'Finance' },
    ...over,
  }
}

registerDriftGuardContract({ label: 'ariel-lookups', handler: driftDetect, sampleItems: [DEPARTMENTS] })

test('ariel-lookups driftDetect: reports in sync when the live lookup matches', async () => {
  const { calls, restore } = recordFetch([list([liveLookup()])])
  try {
    const result = await driftDetect(driftContext([DEPARTMENTS]))

    assert.equal(calls.length, 1)
    assert.equal(pathOf(calls[0]), PATH)
    assert.equal(calls[0].range, 'items=0-9999')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ariel-lookups driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`; reading it would report
  // the real lookup as deleted.
  const { restore } = recordFetch([list([liveLookup()])])
  try {
    const result = await driftDetect(driftContext([DEPARTMENTS]))

    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('ariel-lookups driftDetect: reports a lookup deleted in the console as critical', async () => {
  const { restore } = recordFetch([list([liveLookup({ name: 'something_else' })])])
  try {
    const result = await driftDetect(driftContext([DEPARTMENTS]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'department_lookup', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('ariel-lookups driftDetect: a lookup recreated with another field type is critical', async () => {
  // The type cannot be changed back in place — an operator has to delete and
  // recreate, so this must not read as a warning the next deploy will fix.
  const { restore } = recordFetch([list([liveLookup({ type: 'Integer' })])])
  try {
    const result = await driftDetect(driftContext([DEPARTMENTS]))

    const diff = result.diffs.find((d) => d.field === 'department_lookup.type')
    assert.ok(diff, `expected a type diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.expected, 'String')
    assert.equal(diff.actual, 'Integer')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ariel-lookups driftDetect: reports a default value edited in the console', async () => {
  const { restore } = recordFetch([list([liveLookup({ default_value: 'unassigned' })])])
  try {
    const result = await driftDetect(driftContext([DEPARTMENTS]))

    const diff = result.diffs.find((d) => d.field === 'department_lookup.defaultValue')
    assert.ok(diff)
    assert.equal(diff.expected, 'unknown')
    assert.equal(diff.actual, 'unassigned')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('ariel-lookups driftDetect: reports map entries added or changed in the console', async () => {
  const { restore } = recordFetch([
    list([liveLookup({ map: { hr: 'Human Resources', ops: 'Operations' } })]),
  ])
  try {
    const result = await driftDetect(driftContext([DEPARTMENTS]))

    const diff = result.diffs.find((d) => d.field === 'department_lookup.entries')
    assert.ok(diff, `expected an entries diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.deepEqual(diff.expected, ['fin=Finance', 'hr=Human Resources'])
    assert.deepEqual(diff.actual, ['hr=Human Resources', 'ops=Operations'])
    assert.equal(diff.severity, 'warning')
    assert.equal(result.hasDrift, true)
  } finally {
    restore()
  }
})

test('ariel-lookups driftDetect: a map whose keys came back in another order is not drift', async () => {
  // JSON object key order is not a contract; a handler comparing serialised maps
  // would raise drift on every run for a lookup nobody touched.
  const { restore } = recordFetch([list([liveLookup({ map: { fin: 'Finance', hr: 'Human Resources' } })])])
  try {
    const result = await driftDetect(driftContext([DEPARTMENTS]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('ariel-lookups driftDetect: an empty deployed config checks nothing and never writes', async () => {
  const { calls, restore } = recordFetch([list([])])
  try {
    const result = await driftDetect(driftContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
