import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractTagSpecs, buildTagCreateBody, buildTagUpdateBody, findTag } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'urgent', team_id: '1', color: 'red' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid named color', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

test('validate accepts a custom hex color', async () => {
  const res = await validate(ctxOf([{ name: 'x', team_id: '1', color: 'custom', custom_color: '#ABCDEF' }]))
  assert.equal(res.valid, true)
})

test('validate rejects an invalid color', async () => {
  const res = await validate(ctxOf([{ ...good, color: 'chartreuse' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_COLOR'))
})

test('validate rejects missing name/team', async () => {
  const res = await validate(ctxOf([{ name: '', team_id: '', color: 'red' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEAM'))
})

test('validate warns on a duplicate (team, name)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('extractTagSpecs resolves custom_color when color is "custom"', () => {
  const specs = extractTagSpecs(ctxOf([{ name: 'x', team_id: '1', color: 'custom', custom_color: '#112233' }]).canvas)
  assert.equal(specs[0].color, '#112233')
})

test('buildTagCreateBody / buildTagUpdateBody shapes', () => {
  const spec = { itemName: 'i', name: 'urgent', teamId: '1', color: 'red' }
  assert.deepEqual(buildTagCreateBody(spec), { name: 'urgent', team_id: '1', color: 'red' })
  assert.deepEqual(buildTagUpdateBody(spec), { name: 'urgent', color: 'red' })
})

test('findTag matches within the declared team only', () => {
  const live = [{ id: 1, name: 'urgent', color: 'red', teams: [{ id: 1 }] }]
  assert.equal(findTag(live, '1', 'urgent')?.id, 1)
  assert.equal(findTag(live, '2', 'urgent'), null)
})
