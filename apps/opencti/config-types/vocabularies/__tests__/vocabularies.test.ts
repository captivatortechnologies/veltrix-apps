import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildVocabularyInput,
  buildVocabularyPatch,
  categoryKeyOf,
  findVocabulary,
  toStringList,
  vocabulariesFromList,
} from '../_shared'
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

const good = { category: 'reliability_ov', name: 'high', description: 'Reliable', order: 1, aliases: ['trusted'] }

test('validate rejects an unknown category', async () => {
  const res = await validate(ctxOf([{ ...good, category: 'not_a_real_category' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CATEGORY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a negative / non-integer order', async () => {
  const neg = await validate(ctxOf([{ ...good, order: -1 }]))
  assert.equal(neg.valid, false)
  assert.ok(neg.errors.some((e) => e.code === 'INVALID_ORDER'))

  const frac = await validate(ctxOf([{ ...good, order: 2.5 }]))
  assert.equal(frac.valid, false)
  assert.ok(frac.errors.some((e) => e.code === 'INVALID_ORDER'))
})

test('validate warns on a duplicate category + name pair', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'dup' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_VOCABULARY'))
})

test('validate allows the same name across different categories', async () => {
  const res = await validate(ctxOf([good, { ...good, category: 'integrity_level_ov' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.some((w) => w.code === 'DUPLICATE_VOCABULARY'), false)
})

test('validate accepts a good entry and one with only required fields', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true)
  assert.equal(full.errors.length, 0)

  const bare = await validate(ctxOf([{ category: 'gender_ov', name: 'other' }]))
  assert.equal(bare.valid, true)
  assert.equal(bare.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('toStringList normalizes both array and comma-separated inputs', () => {
  assert.deepEqual(toStringList(['a', 'b', 'a']), ['a', 'b'])
  assert.deepEqual(toStringList('a, b , a'), ['a', 'b'])
  assert.deepEqual(toStringList(''), [])
  assert.deepEqual(toStringList(undefined), [])
})

test('buildVocabularyInput sends category as a bare scalar and omits blanks', () => {
  const input = buildVocabularyInput({ category: 'gender_ov', name: 'other', description: '', order: '', aliases: [] })
  assert.deepEqual(input, { category: 'gender_ov', name: 'other' })

  const full = buildVocabularyInput(good)
  assert.equal(full.category, 'reliability_ov')
  assert.equal(full.description, 'Reliable')
  assert.equal(full.order, 1)
  assert.deepEqual(full.aliases, ['trusted'])
})

test('buildVocabularyPatch never patches the identity and sends order as a native number', () => {
  const patch = buildVocabularyPatch(good)
  assert.ok(patch.every((p) => p.key !== 'category' && p.key !== 'name'))
  const order = patch.find((p) => p.key === 'order')
  assert.deepEqual(order?.value, [1])
  assert.equal(typeof order?.value[0], 'number')
  const aliases = patch.find((p) => p.key === 'aliases')
  assert.deepEqual(aliases?.value, ['trusted'])
})

test('vocabulariesFromList unwraps the edges/node connection and category { key }', () => {
  const list = vocabulariesFromList({
    vocabularies: {
      edges: [
        { node: { id: '1', name: 'high', category: { key: 'reliability_ov' } } },
        { node: { id: '2', name: 'high', category: { key: 'integrity_level_ov' } } },
      ],
    },
  })
  assert.equal(list.length, 2)
  assert.equal(categoryKeyOf(list[0]), 'reliability_ov')
  assert.equal(findVocabulary(list, 'RELIABILITY_OV', 'High')?.id, '1')
})

test('findVocabulary does not collide across categories sharing a name', () => {
  const list = vocabulariesFromList({
    vocabularies: {
      edges: [
        { node: { id: '1', name: 'high', category: { key: 'reliability_ov' } } },
        { node: { id: '2', name: 'high', category: { key: 'integrity_level_ov' } } },
      ],
    },
  })
  assert.equal(findVocabulary(list, 'reliability_ov', 'high')?.id, '1')
  assert.equal(findVocabulary(list, 'integrity_level_ov', 'high')?.id, '2')
  assert.equal(findVocabulary(list, 'gender_ov', 'high'), null)
})
