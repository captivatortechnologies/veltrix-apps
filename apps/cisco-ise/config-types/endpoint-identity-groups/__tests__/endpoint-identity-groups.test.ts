import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the ISE ERS API via node:https
 * inside lib/iseApi, which is impractical to mock here (see lib/__tests__ for the
 * pure-helper coverage of that module). Tests here focus on validate.ts and the
 * pure _shared helpers (field extraction).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ name: '', description: 'x' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a name over the ERS length limit', async () => {
  const res = await validate(ctxOf([{ name: 'a'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects a description over the ERS length limit', async () => {
  const res = await validate(ctxOf([{ name: 'Contractors', description: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('validate warns on a duplicate group name (case-insensitive)', async () => {
  const res = await validate(ctxOf([{ name: 'Contractors' }, { name: 'contractors', description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a well-formed group', async () => {
  const res = await validate(ctxOf([{ name: 'IoT Cameras', description: 'Profiled IoT camera endpoints' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('specFromItem trims name and description', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { name: '  Contractors  ', description: '  temp staff  ' } })
  assert.equal(spec.name, 'Contractors')
  assert.equal(spec.description, 'temp staff')
})

test('specFromItem defaults a missing description to an empty string', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { name: 'Contractors' } })
  assert.equal(spec.description, '')
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([{ name: 'A' }, { name: 'B', description: 'b' }]))
  assert.equal(specs.length, 2)
  assert.deepEqual(specs.map((s) => s.name), ['A', 'B'])
})
