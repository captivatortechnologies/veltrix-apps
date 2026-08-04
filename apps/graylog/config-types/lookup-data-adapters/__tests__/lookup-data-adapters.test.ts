import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildLookupDataAdapterBody, bodyFromLiveLookupDataAdapter, lookupDataAdaptersFromList, findLookupDataAdapter } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'geoip_csv',
  title: 'GeoIP CSV',
  description: '',
  config: '{"type":"csvfile","path":"/etc/graylog/geoip.csv","key_column":"ip","value_column":"country"}',
}

test('validate accepts a well-formed adapter', async () => {
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
  const res = await validate(ctxOf([{ ...good, name: 'Bad Name' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects config missing a type discriminator', async () => {
  const res = await validate(ctxOf([{ ...good, config: '{"path":"/x.csv"}' }]))
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

test('buildLookupDataAdapterBody parses config and omits error-TTL fields when disabled', () => {
  const { body, error } = buildLookupDataAdapterBody(good)
  assert.equal(error, undefined)
  assert.equal(body?.name, 'geoip_csv')
  assert.equal(body?.custom_error_ttl_enabled, undefined)
})

test('buildLookupDataAdapterBody includes error-TTL fields when enabled', () => {
  const { body } = buildLookupDataAdapterBody({ ...good, custom_error_ttl_enabled: true, custom_error_ttl: 120, custom_error_ttl_unit: 'MINUTES' })
  assert.equal(body?.custom_error_ttl_enabled, true)
  assert.equal(body?.custom_error_ttl, 120)
  assert.equal(body?.custom_error_ttl_unit, 'MINUTES')
})

test('bodyFromLiveLookupDataAdapter maps a live adapter back to a request body', () => {
  const body = bodyFromLiveLookupDataAdapter({ name: 'x', title: 'X', config: { type: 'dnslookup' } })
  assert.deepEqual(body.config, { type: 'dnslookup' })
})

test('lookupDataAdaptersFromList + findLookupDataAdapter match by name from the API envelope', () => {
  const live = lookupDataAdaptersFromList({ data_adapters: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] })
  assert.equal(live.length, 2)
  assert.equal(findLookupDataAdapter(live, 'b')?.id, '2')
  assert.equal(findLookupDataAdapter(live, 'nope'), null)
})
