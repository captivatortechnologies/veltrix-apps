import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  attributesToUpdateBody,
  buildCreateBody,
  buildUpdateBody,
  extractLogMetricSpec,
  metricKey,
  toCreatePayload,
  toUpdatePayload,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { id: 'logs.page.load.count', aggregation_type: 'count', filter_query: 'service:web*' }
const distribution = {
  id: 'logs.page.load.duration',
  aggregation_type: 'distribution',
  path: '@duration',
  include_percentiles: true,
  filter_query: 'service:web*',
  group_by: JSON.stringify([{ path: '@http.status_code', tag_name: 'status_code' }]),
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed count metric and a well-formed distribution metric', async () => {
  const count = await validate(ctxOf([good]))
  assert.equal(count.valid, true, JSON.stringify(count.errors))
  const dist = await validate(ctxOf([distribution]))
  assert.equal(dist.valid, true, JSON.stringify(dist.errors))
})

test('validate rejects a missing id and an invalid id shape', async () => {
  const empty = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(empty.valid, false)
  assert.ok(empty.errors.some((e) => e.code === 'EMPTY_ID'))

  const invalid = await validate(ctxOf([{ ...good, id: '1.invalid' }]))
  assert.equal(invalid.valid, false)
  assert.ok(invalid.errors.some((e) => e.code === 'INVALID_ID'))
})

test('validate rejects an unsupported aggregation_type', async () => {
  const res = await validate(ctxOf([{ ...good, aggregation_type: 'sum' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_AGGREGATION_TYPE'))
})

test('validate requires a path for distribution metrics', async () => {
  const res = await validate(ctxOf([{ ...distribution, path: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PATH'))
})

test('validate rejects malformed group_by JSON and an incomplete entry', async () => {
  const bad = await validate(ctxOf([{ ...good, group_by: '{not json' }]))
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_GROUP_BY_JSON'))

  const incomplete = await validate(ctxOf([{ ...good, group_by: JSON.stringify([{ tag_name: 'x' }]) }]))
  assert.equal(incomplete.valid, false)
  assert.ok(incomplete.errors.some((e) => e.code === 'EMPTY_GROUP_BY_PATH'))
})

test('validate rejects a duplicate metric id (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, id: good.id.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_ID'))
})

test('metricKey normalizes case and whitespace', () => {
  assert.equal(metricKey('  Logs.Count '), 'logs.count')
})

test('buildCreateBody only sets path/include_percentiles for distribution', () => {
  const countSpec = extractLogMetricSpec(good)
  const countBody = buildCreateBody(countSpec, [])
  assert.equal('path' in countBody.compute, false)

  const distSpec = extractLogMetricSpec(distribution)
  const distBody = buildCreateBody(distSpec, [{ path: '@http.status_code', tag_name: 'status_code' }])
  assert.equal(distBody.compute.path, '@duration')
  assert.equal(distBody.compute.include_percentiles, true)
  assert.deepEqual(distBody.group_by, [{ path: '@http.status_code', tag_name: 'status_code' }])
})

test('buildUpdateBody never includes aggregation_type or path', () => {
  const spec = extractLogMetricSpec(distribution)
  const body = buildUpdateBody(spec, [])
  assert.equal('aggregation_type' in body.compute, false)
  assert.equal('path' in body.compute, false)
  assert.equal(body.compute.include_percentiles, true)
})

test('attributesToUpdateBody rebuilds the mutable subset from captured live attributes', () => {
  const body = attributesToUpdateBody({ filter: { query: 'q' }, compute: { include_percentiles: true } })
  assert.equal(body.filter.query, 'q')
  assert.equal(body.compute.include_percentiles, true)
  assert.deepEqual(body.group_by, [])
})

test('toCreatePayload / toUpdatePayload wrap the body correctly', () => {
  const spec = extractLogMetricSpec(good)
  const body = buildCreateBody(spec, [])
  const created = toCreatePayload(spec.id, body)
  assert.equal(created.data.id, good.id)
  assert.equal(created.data.type, 'logs_metrics')

  const updateBody = buildUpdateBody(spec, [])
  const updated = toUpdatePayload(updateBody)
  assert.equal('id' in updated.data, false)
})
