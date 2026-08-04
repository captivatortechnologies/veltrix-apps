import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildLookupTableBody, bodyFromLiveLookupTable, lookupTablesFromList, findLookupTable, normalizeDefaultValueType } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'geoip_lookup',
  title: 'GeoIP Lookup',
  description: '',
  cache_name: 'default_cache',
  data_adapter_name: 'geoip_csv',
  default_single_value_type: 'NULL',
  default_multi_value_type: 'NULL',
}

test('validate accepts a well-formed table', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing cache_name', async () => {
  const res = await validate(ctxOf([{ ...good, cache_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CACHE_NAME'))
})

test('validate rejects a missing data_adapter_name', async () => {
  const res = await validate(ctxOf([{ ...good, data_adapter_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DATA_ADAPTER_NAME'))
})

test('validate rejects an invalid default_single_value_type', async () => {
  const res = await validate(ctxOf([{ ...good, default_single_value_type: 'WRONG' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SINGLE_VALUE_TYPE'))
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

test('buildLookupTableBody threads resolved ids and normalizes value types', () => {
  const body = buildLookupTableBody(good, 'cache-1', 'adapter-1')
  assert.equal(body.cache_id, 'cache-1')
  assert.equal(body.data_adapter_id, 'adapter-1')
  assert.equal(body.default_single_value_type, 'NULL')
})

test('normalizeDefaultValueType defaults unknown values to NULL', () => {
  assert.equal(normalizeDefaultValueType('string'), 'STRING')
  assert.equal(normalizeDefaultValueType('nonsense'), 'NULL')
  assert.equal(normalizeDefaultValueType(undefined), 'NULL')
})

test('bodyFromLiveLookupTable maps a live table back to a request body', () => {
  const body = bodyFromLiveLookupTable({ name: 'x', title: 'X', cache_id: 'c1', data_adapter_id: 'a1' })
  assert.equal(body.cache_id, 'c1')
  assert.equal(body.data_adapter_id, 'a1')
})

test('lookupTablesFromList + findLookupTable match by name from the API envelope', () => {
  const live = lookupTablesFromList({ lookup_tables: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] })
  assert.equal(live.length, 2)
  assert.equal(findLookupTable(live, 'b')?.id, '2')
  assert.equal(findLookupTable(live, 'nope'), null)
})
