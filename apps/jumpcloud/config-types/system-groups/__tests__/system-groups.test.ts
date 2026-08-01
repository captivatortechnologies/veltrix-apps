import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractSystemGroupSpecs,
  buildSystemGroupBody,
  findSystemGroupByName,
  priorFieldsOf,
  type JumpCloudSystemGroup,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/health/drift handlers talk to the JumpCloud API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (network-free).
 */
function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = { name: 'Laptops', description: 'All corporate laptops' }

// --- validate -----------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a missing (optional) description', async () => {
  const res = await validate(ctxOf([{ name: 'Servers' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('extractSystemGroupSpecs trims fields and keeps the item id', () => {
  const [spec] = extractSystemGroupSpecs(canvasOf([{ name: '  Kiosks  ', description: ' shared devices ' }]))
  assert.equal(spec.name, 'Kiosks')
  assert.equal(spec.description, 'shared devices')
  assert.equal(spec.itemId, 'i0')
})

test('buildSystemGroupBody always sends name + description', () => {
  const body = buildSystemGroupBody({ name: 'X', description: '' })
  assert.deepEqual(body, { name: 'X', description: '' })
})

test('findSystemGroupByName matches case-insensitively', () => {
  const groups: JumpCloudSystemGroup[] = [{ id: 'a', name: 'Laptops' }, { id: 'b', name: 'Servers' }]
  assert.equal(findSystemGroupByName(groups, 'laptops')?.id, 'a')
  assert.equal(findSystemGroupByName(groups, 'MISSING'), null)
})

test('priorFieldsOf captures the managed subset for rollback', () => {
  const prior = priorFieldsOf({ id: 'a', name: 'Laptops', description: 'd', type: 'system_group' })
  assert.deepEqual(prior, { name: 'Laptops', description: 'd' })
})
