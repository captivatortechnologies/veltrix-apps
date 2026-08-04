import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseTags, tagsFromGet, taggingPath, sortedJoin } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The mutating handlers apply over the Vectra REST API via node:https inside
 * vectraApi, which is impractical to mock here. Tests focus on validate.ts and the
 * pure _shared helpers (tag parsing, path building, comparison).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.entity_id ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { entity_type: 'host', entity_id: '3345', tags: 'crown-jewel, dmz' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good host entity', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a good account entity', async () => {
  const res = await validate(ctxOf([{ ...good, entity_type: 'account' }]))
  assert.equal(res.valid, true)
})

test('validate rejects an unknown entity_type', async () => {
  const res = await validate(ctxOf([{ ...good, entity_type: 'detection' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ENTITY_TYPE'))
})

test('validate rejects a non-numeric entity_id', async () => {
  const res = await validate(ctxOf([{ ...good, entity_id: 'not-a-number' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NON_NUMERIC_ENTITY_ID'))
})

test('validate allows the same entity_id across different entity types', async () => {
  const res = await validate(ctxOf([good, { ...good, entity_type: 'account' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.some((w) => w.code === 'DUPLICATE_ENTITY'), false)
})

test('validate warns on a duplicate (entity_type, entity_id) pair', async () => {
  const res = await validate(ctxOf([good, { ...good, tags: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ENTITY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('parseTags splits on commas/newlines, trims and de-duplicates', () => {
  assert.deepEqual(parseTags('a, b\nb , c'), ['a', 'b', 'c'])
  assert.deepEqual(parseTags(''), [])
})

test('tagsFromGet reads the tags array defensively', () => {
  assert.deepEqual(tagsFromGet({ tags: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(tagsFromGet({}), [])
  assert.deepEqual(tagsFromGet(null), [])
})

test('taggingPath builds the host/account tagging path', () => {
  assert.equal(taggingPath('host', '3345'), '/tagging/host/3345')
  assert.equal(taggingPath('account', '10'), '/tagging/account/10')
})

test('sortedJoin compares order-insensitively', () => {
  assert.equal(sortedJoin(['b', 'a']), sortedJoin(['a', 'b']))
})
