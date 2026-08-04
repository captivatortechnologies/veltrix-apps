import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildStatusTemplateInput, buildStatusTemplatePatch, findStatusTemplate, statusTemplatesFromList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus on
 * validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'In Progress', color: '#ff9800' }

test('validate rejects a missing status template name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing color', async () => {
  const res = await validate(ctxOf([{ ...good, color: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_COLOR'))
})

test('validate rejects a non-hex color', async () => {
  const res = await validate(ctxOf([{ ...good, color: 'orange' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_COLOR'))
})

test('validate warns on a duplicate status template name', async () => {
  const res = await validate(ctxOf([good, { ...good, color: '#000000' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good status template', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildStatusTemplateInput sends both required fields', () => {
  const input = buildStatusTemplateInput(good)
  assert.deepEqual(input, { name: 'In Progress', color: '#ff9800' })
})

test('buildStatusTemplatePatch patches color and never patches the identity', () => {
  const patch = buildStatusTemplatePatch(good)
  assert.ok(patch.every((p) => p.key !== 'name'))
  const color = patch.find((p) => p.key === 'color')
  assert.deepEqual(color?.value, ['#ff9800'])
})

test('statusTemplatesFromList unwraps the edges/node connection', () => {
  const list = statusTemplatesFromList({
    statusTemplates: {
      edges: [{ node: { id: '1', name: 'In Progress' } }, { node: { id: '2', name: 'Resolved' } }],
    },
  })
  assert.equal(list.length, 2)
  assert.equal(findStatusTemplate(list, 'IN PROGRESS')?.id, '1')
})
