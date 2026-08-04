import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  attributesToBody,
  buildSecurityFilterBody,
  extractSecurityFilterSpec,
  findSecurityFilterByName,
  securityFilterKey,
  toPayload,
  type SecurityFilterResource,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Exclude agent logs', query: 'source:datadog.agent', is_enabled: true, filtered_data_type: 'logs' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed filter', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects missing name/query', async () => {
  const res = await validate(ctxOf([{ ...good, name: '', query: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_QUERY'))
})

test('validate rejects an unsupported filtered_data_type', async () => {
  const res = await validate(ctxOf([{ ...good, filtered_data_type: 'metrics' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DATA_TYPE'))
})

test('validate rejects malformed exclusion_filters JSON and incomplete entries', async () => {
  const bad = await validate(ctxOf([{ ...good, exclusion_filters: '{not json' }]))
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_EXCLUSION_FILTERS_JSON'))

  const incomplete = await validate(ctxOf([{ ...good, exclusion_filters: JSON.stringify([{ name: 'x' }]) }]))
  assert.equal(incomplete.valid, false)
  assert.ok(incomplete.errors.some((e) => e.code === 'EMPTY_EXCLUSION_QUERY'))
})

test('validate rejects a duplicate filter name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: good.name.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('securityFilterKey normalizes case and whitespace', () => {
  assert.equal(securityFilterKey('  Exclude Agent '), 'exclude agent')
})

test('findSecurityFilterByName matches case-insensitively', () => {
  const filters: SecurityFilterResource[] = [{ id: 'f1', attributes: { name: 'Exclude Agent' } }]
  assert.equal(findSecurityFilterByName(filters, 'exclude agent')?.id, 'f1')
  assert.equal(findSecurityFilterByName(filters, 'missing'), null)
})

test('buildSecurityFilterBody normalizes exclusion filters and only sets version when given', () => {
  const spec = extractSecurityFilterSpec(good)
  const body = buildSecurityFilterBody(spec, [{ name: 'x', query: 'y' }, { name: 'bad' }], 5)
  assert.equal(body.version, 5)
  assert.deepEqual(body.exclusion_filters, [{ name: 'x', query: 'y' }, { name: 'bad', query: '' }])
})

test('attributesToBody rebuilds a body from captured live attributes', () => {
  const body = attributesToBody({ name: 'N', query: 'Q', is_enabled: false })
  assert.equal(body.name, 'N')
  assert.equal(body.is_enabled, false)
  assert.deepEqual(body.exclusion_filters, [])
})

test('toPayload wraps the body in the JSON:API envelope without an id', () => {
  const spec = extractSecurityFilterSpec(good)
  const body = buildSecurityFilterBody(spec, [])
  const payload = toPayload(body)
  assert.equal(payload.data.type, 'security_filters')
  assert.equal('id' in payload.data, false)
})
