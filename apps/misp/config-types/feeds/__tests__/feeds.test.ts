import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the MISP REST API via node:https inside mispApi, which
 * is impractical to mock here. Tests focus on validate.ts, which is pure and
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'CIRCL OSINT Feed', provider: 'CIRCL', url: 'https://www.circl.lu/doc/misp/feed-osint', sourceFormat: 'misp', enabled: 'enabled' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing URL', async () => {
  const res = await validate(ctxOf([{ ...good, url: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_URL'))
})

test('validate rejects a non-http(s) URL', async () => {
  const res = await validate(ctxOf([{ ...good, url: 'ftp://example.com/feed' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_URL'))
})

test('validate rejects an unknown source format', async () => {
  const res = await validate(ctxOf([{ ...good, sourceFormat: 'stix' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SOURCE_FORMAT'))
})

test('validate warns on a duplicate feed URL', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'Copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_URL'))
})

test('validate accepts a good feed for each source format', async () => {
  for (const sourceFormat of ['misp', 'csv', 'freetext']) {
    const res = await validate(ctxOf([{ ...good, sourceFormat }]))
    assert.equal(res.valid, true, `expected ${sourceFormat} to be valid`)
    assert.equal(res.errors.length, 0)
  }
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})
