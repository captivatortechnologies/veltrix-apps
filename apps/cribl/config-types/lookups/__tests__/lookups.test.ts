import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { LOOKUP, LOOKUP_ID_RE, buildLookupRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Cribl REST API via
 * lib/criblRecordEntities (node:https, impractical to mock here), so tests
 * focus on validate.ts and the pure buildLookupRecord / LOOKUP_ID_RE helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>, settings: Record<string, unknown> = {}): PipelineContext {
  return { canvas: { items: toItems(list) }, settings } as unknown as PipelineContext
}

const good = { id: 'countries.csv', worker_group: 'default', mode: 'memory', content: 'code,name\nUS,United States' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects an id that is not filename-shaped', async () => {
  const res = await validate(ctxOf([{ ...good, id: 'a' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate rejects empty content', async () => {
  const res = await validate(ctxOf([{ ...good, content: '   ' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts a good lookup', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate id within the same worker group', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ID'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- LOOKUP_ID_RE -------------------------------------------------------------

test('LOOKUP_ID_RE accepts filenames with common extensions and rejects a single char', () => {
  assert.ok(LOOKUP_ID_RE.test('countries.csv'))
  assert.ok(LOOKUP_ID_RE.test('geo lookup'))
  assert.ok(LOOKUP_ID_RE.test('asns.mmdb'))
  assert.ok(!LOOKUP_ID_RE.test('a'))
})

// --- buildLookupRecord --------------------------------------------------------

test('buildLookupRecord builds the full body with optional fields', () => {
  const spec = buildLookupRecord({ ...good, description: 'Country lookup', tags: 'geo' }, {})
  assert.equal(spec.error, null)
  assert.deepEqual(spec.body, {
    id: 'countries.csv',
    content: 'code,name\nUS,United States',
    mode: 'memory',
    description: 'Country lookup',
    tags: 'geo',
  })
})

test('buildLookupRecord omits blank optional fields', () => {
  const spec = buildLookupRecord(good, {})
  assert.equal(spec.body?.description, undefined)
  assert.equal(spec.body?.tags, undefined)
})

test('buildLookupRecord defaults mode to memory', () => {
  const spec = buildLookupRecord({ id: 'x1.csv', content: 'a,b' }, {})
  assert.equal(spec.error, null)
  assert.equal(spec.body?.mode, 'memory')
})

// --- descriptor ---------------------------------------------------------------

test('LOOKUP targets the system/lookups collection', () => {
  assert.equal(LOOKUP.resource, 'system/lookups')
  assert.equal(LOOKUP.kind, 'lookup')
})
