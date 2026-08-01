import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildLabelInput, buildLabelPatch, findLabel, labelsFromList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus on
 * validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.value ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { value: 'phishing', color: '#ff9800' }

test('validate rejects a missing label value', async () => {
  const res = await validate(ctxOf([{ ...good, value: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_VALUE'))
})

test('validate rejects a non-hex color', async () => {
  const res = await validate(ctxOf([{ ...good, color: 'orange' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_COLOR'))
})

test('validate warns on a duplicate label value', async () => {
  const res = await validate(ctxOf([good, { ...good, color: '#000000' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_VALUE'))
})

test('validate accepts a good label and an omitted color', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true)
  assert.equal(full.errors.length, 0)

  const bare = await validate(ctxOf([{ value: 'apt' }]))
  assert.equal(bare.valid, true)
  assert.equal(bare.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildLabelInput omits a blank color but keeps the value', () => {
  const input = buildLabelInput({ value: 'apt', color: '' })
  assert.deepEqual(input, { value: 'apt' })

  const full = buildLabelInput(good)
  assert.equal(full.color, '#ff9800')
})

test('buildLabelPatch patches color and never patches the identity', () => {
  const patch = buildLabelPatch(good)
  assert.ok(patch.every((p) => p.key !== 'value'))
  const color = patch.find((p) => p.key === 'color')
  assert.deepEqual(color?.value, ['#ff9800'])
})

test('labelsFromList unwraps the edges/node connection', () => {
  const list = labelsFromList({
    labels: { edges: [{ node: { id: '1', value: 'phishing' } }, { node: { id: '2', value: 'apt' } }] },
  })
  assert.equal(list.length, 2)
  assert.equal(findLabel(list, 'PHISHING')?.id, '1')
})
