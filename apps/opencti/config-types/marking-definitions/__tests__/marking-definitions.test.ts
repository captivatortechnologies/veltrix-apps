import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildMarkingInput, buildMarkingPatch, findMarking, markingsFromList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus on
 * validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.definition ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { definition_type: 'TLP', definition: 'TLP:AMBER', x_opencti_color: '#d68100', x_opencti_order: 3 }

test('validate rejects a missing definition value', async () => {
  const res = await validate(ctxOf([{ ...good, definition: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DEFINITION'))
})

test('validate rejects an unknown marking type', async () => {
  const res = await validate(ctxOf([{ ...good, definition_type: 'CLASSIFICATION' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects a non-hex color', async () => {
  const res = await validate(ctxOf([{ ...good, x_opencti_color: 'amber' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_COLOR'))
})

test('validate rejects a negative / non-integer order', async () => {
  const neg = await validate(ctxOf([{ ...good, x_opencti_order: -1 }]))
  assert.equal(neg.valid, false)
  assert.ok(neg.errors.some((e) => e.code === 'INVALID_ORDER'))

  const frac = await validate(ctxOf([{ ...good, x_opencti_order: 2.5 }]))
  assert.equal(frac.valid, false)
  assert.ok(frac.errors.some((e) => e.code === 'INVALID_ORDER'))
})

test('validate warns on a duplicate definition value', async () => {
  const res = await validate(ctxOf([good, { ...good, x_opencti_color: '#000000' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_DEFINITION'))
})

test('validate accepts a good marking for each type', async () => {
  for (const definition_type of ['TLP', 'PAP', 'STATEMENT']) {
    const res = await validate(ctxOf([{ ...good, definition_type, definition: `${definition_type}:X` }]))
    assert.equal(res.valid, true, `expected ${definition_type} to be valid`)
    assert.equal(res.errors.length, 0)
  }
})

test('validate accepts an omitted color and order', async () => {
  const res = await validate(ctxOf([{ definition_type: 'TLP', definition: 'TLP:RED' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildMarkingInput omits blank color/order but keeps type + definition', () => {
  const input = buildMarkingInput({ definition_type: 'TLP', definition: 'TLP:GREEN', x_opencti_color: '', x_opencti_order: '' })
  assert.deepEqual(input, { definition_type: 'TLP', definition: 'TLP:GREEN' })

  const full = buildMarkingInput(good)
  assert.equal(full.x_opencti_color, '#d68100')
  assert.equal(full.x_opencti_order, 3)
})

test('buildMarkingPatch stringifies order and never patches the identity', () => {
  const patch = buildMarkingPatch(good)
  assert.ok(patch.every((p) => p.key !== 'definition'))
  const order = patch.find((p) => p.key === 'x_opencti_order')
  assert.deepEqual(order?.value, ['3'])
})

test('markingsFromList unwraps the edges/node connection', () => {
  const list = markingsFromList({
    markingDefinitions: { edges: [{ node: { id: '1', definition: 'TLP:AMBER' } }, { node: { id: '2', definition: 'PAP:RED' } }] },
  })
  assert.equal(list.length, 2)
  assert.equal(findMarking(list, 'tlp:amber')?.id, '1')
})
