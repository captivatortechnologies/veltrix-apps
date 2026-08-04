import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildLookupCacheBody, bodyFromLiveLookupCache, lookupCachesFromList, findLookupCache } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'default_cache',
  title: 'Default Cache',
  description: '',
  config: '{"type":"guava_cache","max_size":1000}',
}

test('validate accepts a well-formed cache', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'Bad Name!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects config missing a type discriminator', async () => {
  const res = await validate(ctxOf([{ ...good, config: '{"max_size":1000}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIG'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, title: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildLookupCacheBody parses config and carries identity', () => {
  const { body, error } = buildLookupCacheBody(good)
  assert.equal(error, undefined)
  assert.equal(body?.name, 'default_cache')
  assert.deepEqual(body?.config, { type: 'guava_cache', max_size: 1000 })
})

test('bodyFromLiveLookupCache maps a live cache back to a request body', () => {
  const body = bodyFromLiveLookupCache({ name: 'x', title: 'X', config: { type: 'none' } })
  assert.deepEqual(body.config, { type: 'none' })
})

test('lookupCachesFromList + findLookupCache match by name from the API envelope', () => {
  const live = lookupCachesFromList({ caches: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] })
  assert.equal(live.length, 2)
  assert.equal(findLookupCache(live, 'b')?.id, '2')
  assert.equal(findLookupCache(live, 'nope'), null)
})
