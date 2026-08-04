import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildFrameworkBody, isValidSectionsShape, type FrameworkSection } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers apply over the Orca REST API via lib/orcaApi (fetch),
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodSections: FrameworkSection[] = [
  { name: 'Access Control', tests: [{ rule_id: 'r123', rule_id_in_framework: '1.1' }] },
]

const good = {
  name: 'My Custom Framework',
  description: 'Custom compliance framework managed by Veltrix',
  sections: JSON.stringify(goodSections),
}

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed framework', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing description', async () => {
  const res = await validate(ctxOf([{ ...good, description: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESCRIPTION'))
})

test('validate rejects malformed JSON sections', async () => {
  const res = await validate(ctxOf([{ ...good, sections: '{oops}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SECTIONS'))
})

test('validate rejects sections missing a rule_id', async () => {
  const res = await validate(ctxOf([{ ...good, sections: JSON.stringify([{ name: 'X', tests: [{ rule_id_in_framework: '1.1' }] }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SECTIONS'))
})

test('validate warns on empty sections', async () => {
  const res = await validate(ctxOf([{ ...good, sections: '[]' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_SECTIONS'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('isValidSectionsShape accepts a well-formed sections array', () => {
  assert.equal(isValidSectionsShape(goodSections), true)
})

test('isValidSectionsShape rejects a non-array', () => {
  assert.equal(isValidSectionsShape({ name: 'x' }), false)
})

test('isValidSectionsShape rejects a test missing rule_id_in_framework', () => {
  assert.equal(isValidSectionsShape([{ name: 'X', tests: [{ rule_id: 'r1' }] }]), false)
})

test('buildFrameworkBody includes checkedKeys only on create', () => {
  const created = buildFrameworkBody({ ...good, checkedKeys: ['a', 'b'] }, goodSections, true)
  assert.deepEqual(created.checkedKeys, ['a', 'b'])
  assert.equal(created.name, good.name)
  assert.deepEqual(created.sections, goodSections)

  const updated = buildFrameworkBody(good, goodSections, false)
  assert.equal(updated.checkedKeys, undefined)
})
