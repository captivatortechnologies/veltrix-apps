import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildLogIndexBody, extractLogIndexSpec, indexKey, indexToBody, parseOptionalNumber } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'main', filter_query: 'source:python', num_retention_days: 15, daily_limit: 300000000, tags: ['team:backend'] }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed index', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing name and a name too long', async () => {
  const empty = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(empty.valid, false)
  assert.ok(empty.errors.some((e) => e.code === 'EMPTY_NAME'))

  const long = await validate(ctxOf([{ ...good, name: 'x'.repeat(81) }]))
  assert.equal(long.valid, false)
  assert.ok(long.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects a negative retention or daily limit', async () => {
  const res = await validate(ctxOf([{ ...good, num_retention_days: -1, daily_limit: -5 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RETENTION'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DAILY_LIMIT'))
})

test('validate rejects malformed exclusion_filters JSON and an incomplete entry', async () => {
  const bad = await validate(ctxOf([{ ...good, exclusion_filters: '{not json' }]))
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_EXCLUSION_FILTERS_JSON'))

  const incomplete = await validate(ctxOf([{ ...good, exclusion_filters: JSON.stringify([{}]) }]))
  assert.equal(incomplete.valid, false)
  assert.ok(incomplete.errors.some((e) => e.code === 'EMPTY_EXCLUSION_NAME'))
})

test('validate rejects a duplicate index name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: good.name.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('indexKey normalizes case and whitespace', () => {
  assert.equal(indexKey('  Main '), 'main')
})

test('parseOptionalNumber: blank is undefined, a number parses, garbage is NaN', () => {
  assert.equal(parseOptionalNumber(''), undefined)
  assert.equal(parseOptionalNumber('15'), 15)
  assert.ok(Number.isNaN(parseOptionalNumber('not-a-number')))
})

test('buildLogIndexBody omits retention/daily_limit when undefined and normalizes exclusion filters', () => {
  const spec = extractLogIndexSpec(good)
  const withValues = buildLogIndexBody(spec, [{ name: 'x', filter: { query: 'y' } }], 15, 100)
  assert.equal(withValues.num_retention_days, 15)
  assert.equal(withValues.daily_limit, 100)
  assert.deepEqual(withValues.exclusion_filters, [{ name: 'x', is_enabled: true, filter: { query: 'y' } }])

  const withoutValues = buildLogIndexBody(spec, [], undefined, undefined)
  assert.equal('num_retention_days' in withoutValues, false)
  assert.equal('daily_limit' in withoutValues, false)
})

test('indexToBody rebuilds a body from a captured live index, defaulting missing fields', () => {
  const body = indexToBody({ name: 'main' })
  assert.equal(body.name, 'main')
  assert.equal(body.filter.query, '')
  assert.deepEqual(body.exclusion_filters, [])
  assert.deepEqual(body.tags, [])
})
