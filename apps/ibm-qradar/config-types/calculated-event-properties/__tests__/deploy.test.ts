// deploy for calculated-event-properties.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the operand encoding: the canvas declares a type plus one free-text value, and
// deploy has to turn that into either `{ type: 'STATIC', numeric_value: <number> }`
// or `{ type: 'PROPERTY', property_name: <string> }`. Get the key or the JSON
// type wrong and QRadar stores a property that computes something else entirely,
// which no later handler would notice.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACCEPTED,
  assertQRadarHeaders,
  bodyOf,
  created,
  deployContext,
  item,
  leaksToken,
  list,
  pathOf,
  qradarError,
  routeFetch,
  writeCalls,
  type CannedResponse,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

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

const SCALED = item(
  'Megabytes',
  {
    name: 'Megabytes',
    description: 'Bytes expressed in MB',
    enabled: true,
    operator: 'DIVIDE',
    firstOperandType: 'PROPERTY',
    firstOperandValue: 'Bytes',
    secondOperandType: 'STATIC',
    secondOperandValue: '1048576',
  },
  'item-scaled',
)

/** The live record that matches RATIO exactly, before per-test edits. */
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

registerDeployGuardContract({ label: 'calculated-event-properties', handler: deploy, sampleItems: [RATIO] })

function fakeConsole(opts: { properties?: unknown[]; write?: CannedResponse; remove?: CannedResponse } = {}) {
  return routeFetch([
    { url: /\/calculated_properties/, method: 'GET', respond: list(opts.properties ?? []) },
    { url: /\/calculated_properties/, method: 'POST', respond: opts.write ?? created({ id: 55 }) },
    { url: /\/calculated_properties/, method: 'DELETE', respond: opts.remove ?? ACCEPTED },
  ])
}

function entriesOf(result: { rollbackData?: unknown }): Array<Record<string, unknown>> {
  return (result.rollbackData as { entries?: Array<Record<string, unknown>> } | undefined)?.entries ?? []
}

test('calculated-event-properties deploy: creates a property that does not exist, with PROPERTY operands', async () => {
  const { calls, restore } = fakeConsole({ properties: [] })
  try {
    const result = await deploy(deployContext([RATIO]))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), PATH)
    assert.equal(calls[0].range, 'items=0-9999', 'the whole list is read, not the first page')

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(pathOf(writes[0]), PATH)
    assert.deepEqual(bodyOf(writes[0]), {
      name: 'Bytes Per Packet',
      description: 'Average bytes per packet',
      enabled: true,
      operator: 'DIVIDE',
      first_operand: { type: 'PROPERTY', property_name: 'Bytes' },
      second_operand: { type: 'PROPERTY', property_name: 'Packets' },
    })

    assert.equal(result.success, true)
    const entries = entriesOf(result)
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 55)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('calculated-event-properties deploy: a STATIC operand is sent as a numeric_value, as a JSON number', async () => {
  // The canvas field is free text. Sending "1048576" as a string, or under
  // `property_name`, gives QRadar a property that silently computes nothing.
  const { calls, restore } = fakeConsole({ properties: [] })
  try {
    await deploy(deployContext([SCALED]))

    const body = bodyOf(writeCalls(calls)[0]) as Record<string, Record<string, unknown>>
    assert.deepEqual(body.second_operand, { type: 'STATIC', numeric_value: 1048576 })
    assert.equal(typeof body.second_operand.numeric_value, 'number')
    assert.deepEqual(body.first_operand, { type: 'PROPERTY', property_name: 'Bytes' })
  } finally {
    restore()
  }
})

test('calculated-event-properties deploy: an operand changed on its own still triggers the update', async () => {
  // Name, description, enabled and operator all match; only the second operand
  // differs. A comparison that skipped the operands would leave the console
  // computing the old expression and report success.
  const { calls, restore } = fakeConsole({
    properties: [liveProperty({ second_operand: { type: 'PROPERTY', property_name: 'Duration' } })],
  })
  try {
    const result = await deploy(deployContext([RATIO]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an operand-only difference must be written')
    assert.equal(pathOf(writes[0]), `${PATH}/21`, 'an existing property is updated by id, never re-created')
    assert.deepEqual((bodyOf(writes[0]) as Record<string, unknown>).second_operand, {
      type: 'PROPERTY',
      property_name: 'Packets',
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('calculated-event-properties deploy: updating records the LIVE prior state, not the desired one', async () => {
  // Every field of the live record deliberately differs from the canvas, so a
  // handler that captured the values it was about to write would be caught.
  const { restore } = fakeConsole({
    properties: [
      liveProperty({
        description: 'Edited in the console',
        enabled: false,
        operator: 'MULTIPLY',
        second_operand: { type: 'STATIC', numeric_value: 8 },
      }),
    ],
  })
  try {
    const result = await deploy(deployContext([RATIO]))

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 21)
    assert.deepEqual(entries[0].prior, {
      name: 'Bytes Per Packet',
      description: 'Edited in the console',
      enabled: false,
      operator: 'MULTIPLY',
      first_operand: { type: 'PROPERTY', property_name: 'Bytes' },
      second_operand: { type: 'STATIC', numeric_value: 8 },
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('calculated-event-properties deploy: a property that already matches is not written, but is still recorded', async () => {
  const { calls, restore } = fakeConsole({ properties: [liveProperty()] })
  try {
    const result = await deploy(deployContext([RATIO]))

    assert.equal(writeCalls(calls).length, 0, 'an unchanged property must not be rewritten')
    const entries = entriesOf(result)
    assert.equal(entries.length, 1, 'rollback still needs to know the property was under management')
    assert.equal(entries[0].existed, true)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('calculated-event-properties deploy: a rejected create is a failed result, not a thrown error', async () => {
  const { restore } = fakeConsole({
    properties: [],
    write: qradarError(422, 'The referenced property "Packets" does not exist'),
  })
  try {
    const result = await deploy(deployContext([RATIO]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /does not exist/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('calculated-event-properties deploy: one rejected property does not stop the rest of the canvas', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/calculated_properties$/, method: 'GET', respond: list([]) },
    {
      url: /\/calculated_properties$/,
      method: 'POST',
      respond: [qradarError(422, 'The referenced property "Packets" does not exist'), created({ id: 56 })],
    },
  ])
  try {
    const result = await deploy(deployContext([RATIO, SCALED]))

    assert.equal(writeCalls(calls).length, 2, 'the second property is still attempted')
    assert.equal(result.success, false)
    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'Megabytes')
  } finally {
    restore()
  }
})

test('calculated-event-properties deploy: deletes a property it created before and no longer declares', async () => {
  const { calls, restore } = fakeConsole({ properties: [] })
  try {
    const result = await deploy(
      deployContext([RATIO], {
        priorRollbackData: {
          entries: [
            { itemId: 'item-old', name: 'Retired Metric', existed: false, id: 61 },
            { itemId: 'item-op', name: 'Operator Owned', existed: true, id: 62 },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${PATH}/61`])
    assert.equal(
      deletes.some((p) => p.endsWith('/62')),
      false,
      'a property that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('calculated-event-properties deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = fakeConsole({ properties: [] })
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})
