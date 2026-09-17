// driftDetect for calculated-event-properties.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: the live list is read once and each deployed property is looked
// up by name, so "the console no longer has this property" is a real, critical
// diff, while a property switched off or given another operator is a warning the
// next deploy repairs.
//
// NOTE: this handler compares only the operator and the enabled flag. The
// operands and the description are NOT compared, so a console edit to either is
// reported as in sync — that gap is in the defect report, and no test here
// asserts it as correct.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, pathOf, recordFetch, writeCalls } from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/config/event_sources/custom_properties/calculated_properties'

const RATIO = item(
  'Bytes Per Packet',
  {
    name: 'Bytes Per Packet',
    description: 'Average bytes per packet',
    enabled: true,
    operator: 'DIVIDE',
    firstOperandType: 'PROPERTY',
    firstOperandValue: 'Bytes',
    secondOperandType: 'PROPERTY',
    secondOperandValue: 'Packets',
  },
  'item-ratio',
)

function liveProperty(over: Record<string, unknown> = {}) {
  return {
    id: 21,
    name: 'Bytes Per Packet',
    description: 'Average bytes per packet',
    enabled: true,
    operator: 'DIVIDE',
    first_operand: { type: 'PROPERTY', property_name: 'Bytes' },
    second_operand: { type: 'PROPERTY', property_name: 'Packets' },
    ...over,
  }
}

registerDriftGuardContract({ label: 'calculated-event-properties', handler: driftDetect, sampleItems: [RATIO] })

test('calculated-event-properties driftDetect: reports in sync when the live property matches', async () => {
  const { calls, restore } = recordFetch([list([liveProperty()])])
  try {
    const result = await driftDetect(driftContext([RATIO]))

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

test('calculated-event-properties driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`; reading it would report
  // the real property as deleted.
  const { restore } = recordFetch([list([liveProperty()])])
  try {
    const result = await driftDetect(driftContext([RATIO]))

    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('calculated-event-properties driftDetect: reports a property deleted in the console as critical', async () => {
  const { restore } = recordFetch([list([liveProperty({ id: 99, name: 'Something Else' })])])
  try {
    const result = await driftDetect(driftContext([RATIO]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Bytes Per Packet', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('calculated-event-properties driftDetect: reports an operator changed in the console', async () => {
  const { restore } = recordFetch([list([liveProperty({ operator: 'MULTIPLY' })])])
  try {
    const result = await driftDetect(driftContext([RATIO]))

    const diff = result.diffs.find((d) => d.field === 'Bytes Per Packet.operator')
    assert.ok(diff, `expected an operator diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.expected, 'DIVIDE')
    assert.equal(diff.actual, 'MULTIPLY')
    assert.equal(diff.severity, 'warning')
    assert.equal(result.hasDrift, true)
  } finally {
    restore()
  }
})

test('calculated-event-properties driftDetect: reports a property switched off in the console', async () => {
  // A disabled calculated property stops populating, so searches and rules built
  // on it quietly return nothing.
  const { restore } = recordFetch([list([liveProperty({ enabled: false })])])
  try {
    const result = await driftDetect(driftContext([RATIO]))

    const diff = result.diffs.find((d) => d.field === 'Bytes Per Packet.enabled')
    assert.ok(diff)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('calculated-event-properties driftDetect: reports every drifted property, not just the first', async () => {
  const OTHER = item(
    'Megabytes',
    {
      name: 'Megabytes',
      enabled: true,
      operator: 'DIVIDE',
      firstOperandType: 'PROPERTY',
      firstOperandValue: 'Bytes',
      secondOperandType: 'STATIC',
      secondOperandValue: '1048576',
    },
    'item-scaled',
  )
  const { restore } = recordFetch([list([liveProperty({ enabled: false })])])
  try {
    const result = await driftDetect(driftContext([RATIO, OTHER]))

    assert.deepEqual(result.diffs.map((d) => d.field), ['Bytes Per Packet.enabled', 'Megabytes'])
    assert.equal(result.hasDrift, true)
  } finally {
    restore()
  }
})

test('calculated-event-properties driftDetect: an empty deployed config checks nothing and never writes', async () => {
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
